import process from "node:process";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { redactSecrets } from "../server/chief/managed/redact.js";
import {
  listMigrationNames,
  migrationsToWithhold,
  readAppliedMigrationNames,
  proofMigrateAllowed,
  withholdMigrationDirectories,
  databaseHost,
} from "./proof-migration-guard.mjs";
import { classifyMigrationTree, loadHistoryManifest } from "./migration-classify.mjs";
import { evaluateMigrationIdentity } from "./migration-identity.mjs";

// Applies pending Prisma migrations. The application build does not call this.
// Additive migrations are the only ones that start Prisma. Anything else
// prints the blocking directory, its sha256, and the authorization command,
// then exits non-zero without spawning Prisma. A timeout, a Prisma failure,
// an unreadable history, an identity mismatch, or an incomplete applied set
// also exits non-zero. This script never calls `prisma migrate resolve`.

const PLACEHOLDER_DATABASE_URL = "postgresql://postgres:password@localhost:5432/forward_freedom";
const MIGRATIONS_DIR = path.resolve("prisma/migrations");
const MIGRATE_TIMEOUT_MS = 90_000;

function fail(reason, extra = {}) {
  return { ok: false, spawned: false, reason, ...extra };
}

function reportFailure(reason, applied = []) {
  process.stderr.write(
    `[prisma-migrate-deploy] migrations were NOT applied: ${reason}\n` +
      `[prisma-migrate-deploy] applied ${applied.length ? applied.join(", ") : "(none)"}\n`
  );
}

export function parseAuthorizeArgs(argv) {
  const args = argv || [];
  const nameIndex = args.indexOf("--authorize");
  const shaIndex = args.indexOf("--sha256");
  if (nameIndex === -1 && shaIndex === -1) return null;
  const name = nameIndex === -1 ? "" : args[nameIndex + 1];
  const digest = shaIndex === -1 ? "" : args[shaIndex + 1];
  if (!name || name.startsWith("--") || !/^[a-f0-9]{64}$/.test(digest || "")) {
    return { invalid: true };
  }
  return { name, sha256: digest };
}

function defaultSpawn({ env, cwd }) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env,
      cwd,
      shell: process.platform === "win32",
    });
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, MIGRATE_TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timeoutHandle);
      resolve({ code: timedOut ? null : code, timedOut, error: null });
    });
    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      resolve({ code: 1, timedOut: false, error });
    });
  });
}

async function openPool(env) {
  const connectionString = env.DIRECT_URL || env.DATABASE_URL;
  const pg = (await import("pg")).default;
  const { buildPgPoolConfig } = await import("../server/db/pgPoolConfig.js");
  return new pg.Pool({
    ...buildPgPoolConfig(connectionString),
    connectionTimeoutMillis: 15_000,
    query_timeout: 15_000,
    max: 1,
  });
}

async function readIdentity(env) {
  const pool = await openPool(env);
  try {
    const sessionResult = await pool.query(
      "SELECT current_user AS migrate_role, current_database() AS database_name"
    );
    try {
      const identity = await pool.query(
        `SELECT environment, database_name, migrate_role FROM freedom_migration_identity`
      );
      return { session: sessionResult.rows[0], rows: identity.rows, readError: null };
    } catch (error) {
      return { session: sessionResult.rows[0], rows: [], readError: error };
    }
  } finally {
    await pool.end();
  }
}

function applyAuthorization(classified, authorize) {
  if (!authorize) return { classified, refusal: null };
  if (authorize.invalid) return { classified, refusal: fail("authorization_checksum_mismatch") };
  const file = classified.files.find((entry) => entry.name === authorize.name);
  if (!file || file.sha256 !== authorize.sha256) {
    return { classified, refusal: fail("authorization_checksum_mismatch") };
  }
  const files = classified.files.map((entry) =>
    entry.name === authorize.name ? { ...entry, class: "additive", reason: "authorized" } : entry
  );
  const blocked = files.find((entry) => entry.class !== "additive" && entry.class !== "historical");
  return { classified: { files, blocked: blocked || null }, refusal: null };
}

export async function deployMigrations({
  env = process.env,
  migrationsDir = MIGRATIONS_DIR,
  cwd = process.cwd(),
  spawnImpl = defaultSpawn,
  authorize = null,
  manifest = null,
} = {}) {
  const databaseUrl = (env.DATABASE_URL || "").trim();
  const target = env.CHIEF_MIGRATE_TARGET;
  if (!databaseUrl || databaseUrl === PLACEHOLDER_DATABASE_URL) {
    if (target === "production" || target === "preview") {
      reportFailure("database_missing");
      return fail("database_missing");
    }
    process.stdout.write(
      "[prisma-migrate-deploy] No database configured; skipping migrate deploy.\n"
    );
    return { ok: true, skipped: true, spawned: false, withheld: [] };
  }

  const host = databaseHost(env.DIRECT_URL || databaseUrl);
  process.stdout.write(`[prisma-migrate-deploy] database host ${host}\n`);

  let identity;
  try {
    identity = await readIdentity(env);
  } catch (error) {
    reportFailure(`identity_unreadable (${redactSecrets(error.message)})`);
    return fail("identity_unreadable");
  }
  const decision = evaluateMigrationIdentity({ env, ...identity });
  if (!decision.ok) {
    reportFailure(decision.reason);
    return fail(decision.reason);
  }

  let appliedNames = [];
  try {
    appliedNames = await readAppliedMigrationNames(env);
  } catch (error) {
    reportFailure(`history_unreadable (${redactSecrets(error.message)})`);
    return fail("history_unreadable");
  }

  const allowProofMigrate = proofMigrateAllowed(env);
  if (env.CHIEF_PROOF_MIGRATE === "1" && !allowProofMigrate) {
    process.stdout.write(
      "[prisma-migrate-deploy] Ignoring CHIEF_PROOF_MIGRATE. Proof migrations run only on a loopback database outside Vercel.\n"
    );
  }
  const migrationNames = listMigrationNames(migrationsDir);
  const withheld = migrationsToWithhold({
    migrationsDir,
    migrationNames,
    appliedNames,
    allowProofMigrate,
  });
  const pending = migrationNames.filter(
    (name) => !appliedNames.includes(name) && !withheld.includes(name)
  );
  let classified;
  try {
    classified = await classifyMigrationTree({
      migrationsDir,
      manifest: manifest || loadHistoryManifest(),
      names: pending,
    });
  } catch (error) {
    reportFailure(`classify_failed (${redactSecrets(error.message)})`, appliedNames);
    return fail("classify_failed", { applied: appliedNames });
  }
  const authorized = applyAuthorization(classified, authorize);
  if (authorized.refusal) {
    reportFailure(authorized.refusal.reason, appliedNames);
    return { ...authorized.refusal, applied: appliedNames };
  }
  classified = authorized.classified;
  if (classified.blocked) {
    const blocked = classified.blocked;
    process.stdout.write(
      `[prisma-migrate-deploy] blocked ${blocked.name} sha256=${blocked.sha256}\n` +
        `[prisma-migrate-deploy] ${blocked.command}\n`
    );
    reportFailure(`blocked:${blocked.class}`, appliedNames);
    return fail("blocked", {
      blocked,
      applied: appliedNames,
      command: blocked.command,
    });
  }

  const restore = withheld.length
    ? withholdMigrationDirectories(migrationsDir, withheld)
    : () => {};
  if (withheld.length) {
    process.stdout.write(
      `[prisma-migrate-deploy] Withholding proof-only migrations: ${withheld.join(", ")}\n`
    );
  }
  process.stdout.write("[prisma-migrate-deploy] Applying pending migrations…\n");
  try {
    const result = await spawnImpl({ env, cwd });
    if (result.timedOut) {
      reportFailure(`timed out after ${MIGRATE_TIMEOUT_MS / 1000}s`, appliedNames);
      return fail("timeout", { spawned: true, applied: appliedNames, withheld });
    }
    if (result.error) {
      reportFailure(
        `failed to start prisma migrate deploy: ${redactSecrets(result.error.message)}`,
        appliedNames
      );
      return fail("spawn_error", { spawned: true, applied: appliedNames, withheld });
    }
    if (result.code !== 0) {
      reportFailure(`prisma migrate deploy exited with code ${result.code}`, appliedNames);
      return fail("prisma_failed", { spawned: true, applied: appliedNames, withheld });
    }
    let appliedAfter = appliedNames;
    try {
      appliedAfter = await readAppliedMigrationNames(env);
    } catch (error) {
      reportFailure(`history_unreadable (${redactSecrets(error.message)})`, appliedNames);
      return fail("history_unreadable", { spawned: true, applied: appliedNames, withheld });
    }
    const missing = migrationNames.filter(
      (name) => !withheld.includes(name) && !appliedAfter.includes(name)
    );
    if (missing.length) {
      reportFailure(`incomplete:${missing.join(",")}`, appliedAfter);
      return fail("incomplete", { spawned: true, applied: appliedAfter, withheld });
    }
    process.stdout.write("[prisma-migrate-deploy] Migrations applied successfully.\n");
    return { ok: true, spawned: true, applied: appliedAfter, withheld };
  } finally {
    restore();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  deployMigrations({ authorize: parseAuthorizeArgs(process.argv.slice(2)) })
    .then((result) => {
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      reportFailure(redactSecrets(error.message));
      process.exit(1);
    });
}

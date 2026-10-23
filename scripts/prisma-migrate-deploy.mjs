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
} from "./proof-migration-guard.mjs";

// Applies pending Prisma migrations during the build (e.g. on Vercel) so the
// database schema is always in sync with the deployed code. This prevents the
// "column ... does not exist" failures that occur when new code is deployed
// before its migration has been applied.
//
// It only runs when a real DATABASE_URL is configured. Local/preview builds
// without a database (or using the generate-only placeholder) are skipped so
// they keep working.
//
// Proof-only migrations stay in prisma/migrations so an isolated database can
// apply the full history. This script withholds any that are not already
// recorded. CHIEF_PROOF_MIGRATE=1 applies them only for a loopback database
// outside Vercel. The flag is ignored for production, preview, and any
// remote host, so it cannot apply proof migrations to production.
//
// IMPORTANT: this step is intentionally NON-BLOCKING. The runtime has a
// schema-compatibility layer (server/db/schemaCapabilities.js) that tolerates
// an un-migrated database, so a migration hiccup here (unreachable DB, pooler
// misconfiguration, transient network error) must never fail the deploy —
// blocking the deploy would keep older, potentially broken code in
// production, which is strictly worse than deploying with a lagging
// migration.

const PLACEHOLDER_DATABASE_URL = "postgresql://postgres:password@localhost:5432/forward_freedom";
const MIGRATIONS_DIR = path.resolve("prisma/migrations");
const MIGRATE_TIMEOUT_MS = 90_000;

function warnAndContinue(reason) {
  process.stderr.write(
    "\n" +
      "╔════════════════════════════════════════════════════════════════════╗\n" +
      "║ [prisma-migrate-deploy] WARNING: migrations were NOT applied.       ║\n" +
      "╚════════════════════════════════════════════════════════════════════╝\n" +
      `Reason: ${reason}\n` +
      "The deploy will continue — the app tolerates an un-migrated database\n" +
      "via its schema-compatibility layer — but the pending migrations still\n" +
      "need to be applied for new columns/features (e.g. at-rest encryption)\n" +
      "to activate.\n" +
      "Checklist:\n" +
      "  1. DIRECT_URL must be set to Supabase's *session pooler* or direct\n" +
      "     connection string (host *.pooler.supabase.com, port 5432, no\n" +
      "     pgbouncer param). Transaction-mode pooler URLs (port 6543) hang\n" +
      "     or fail — Prisma Migrate cannot run schema changes through them.\n" +
      "  2. DATABASE_URL (app runtime) can stay on the transaction pooler.\n" +
      "  3. Alternatively run `npm run db:migrate` manually with DIRECT_URL.\n" +
      "  4. Proof migrations stay withheld on Vercel and on any non-loopback database.\n\n"
  );
}

function runPrismaDeploy() {
  return new Promise((resolve) => {
    const child = spawn("npx", ["prisma", "migrate", "deploy"], {
      stdio: "inherit",
      env: process.env,
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

export async function deployMigrations({ env = process.env, migrationsDir = MIGRATIONS_DIR } = {}) {
  const databaseUrl = (env.DATABASE_URL || "").trim();
  if (!databaseUrl || databaseUrl === PLACEHOLDER_DATABASE_URL) {
    process.stdout.write(
      "[prisma-migrate-deploy] No production DATABASE_URL configured; skipping migrate deploy.\n"
    );
    return { skipped: true, withheld: [] };
  }

  const allowProofMigrate = proofMigrateAllowed(env);
  if (env.CHIEF_PROOF_MIGRATE === "1" && !allowProofMigrate) {
    process.stdout.write(
      "[prisma-migrate-deploy] Ignoring CHIEF_PROOF_MIGRATE. Proof migrations run only on a loopback database outside Vercel.\n"
    );
  }
  let appliedNames = [];
  if (!allowProofMigrate) {
    try {
      appliedNames = await readAppliedMigrationNames(env);
    } catch (error) {
      process.stderr.write(
        `[prisma-migrate-deploy] Could not read migration history (${redactSecrets(error.message)}). Pending proof migrations will be withheld.\n`
      );
    }
  }
  const withheld = migrationsToWithhold({
    migrationsDir,
    migrationNames: listMigrationNames(migrationsDir),
    appliedNames,
    allowProofMigrate,
  });
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
    const result = await runPrismaDeploy();
    if (result.timedOut) {
      warnAndContinue(
        `timed out after ${MIGRATE_TIMEOUT_MS / 1000}s — the migrations connection is unreachable or blocked (typical of a transaction-mode pooler URL).`
      );
    } else if (result.error) {
      warnAndContinue(
        `failed to start \`prisma migrate deploy\`: ${redactSecrets(result.error.message)}`
      );
    } else if (result.code !== 0) {
      warnAndContinue(`\`prisma migrate deploy\` exited with code ${result.code}.`);
    } else {
      process.stdout.write("[prisma-migrate-deploy] Migrations applied successfully.\n");
    }
    return { skipped: false, withheld, code: result.code };
  } finally {
    restore();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  deployMigrations()
    .catch((error) => {
      warnAndContinue(redactSecrets(error.message));
    })
    .finally(() => {
      process.exit(0);
    });
}

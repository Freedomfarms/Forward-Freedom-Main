// Disposable-database compatibility checks.
//
// New code is run against the base schema. The base Prisma schema is compared
// with information_schema after the expanded migrations. A missing base column
// or an unhandled missing column fails. Extra nullable columns do not.
//
// The job refuses freedom_migrate_production and freedom_migrate_preview
// before it applies SQL. Authorization-required index and foreign-key
// statements are executed only on this disposable database. Their Postgres
// result does not make them automatic.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  getSchemaCapabilities,
  resetSchemaCapabilitiesCache,
} from "../server/db/schemaCapabilities.js";
import { databaseHost, isLoopbackHost } from "./proof-migration-guard.mjs";
import {
  automaticMigrate,
  classifyMigrationTree,
  loadHistoryManifest,
} from "./migration-classify.mjs";
import { schemaCompatRoleAllowed } from "./migration-identity.mjs";
import { deployMigrations } from "./prisma-migrate-deploy.mjs";
import { reserveHold } from "../server/chief/models/budget.js";

const SCALARS = new Set([
  "String",
  "Int",
  "Boolean",
  "DateTime",
  "Json",
  "Decimal",
  "BigInt",
  "Float",
  "Bytes",
]);

const COMPATIBLE = {
  String: new Set(["text", "character varying"]),
  Int: new Set(["integer"]),
  Boolean: new Set(["boolean"]),
  DateTime: new Set(["timestamp without time zone", "timestamp with time zone"]),
  Json: new Set(["jsonb", "json"]),
  Decimal: new Set(["numeric"]),
  BigInt: new Set(["bigint"]),
  Float: new Set(["double precision", "real"]),
  Bytes: new Set(["bytea"]),
  enum: new Set(["USER-DEFINED"]),
};

export function diffDecision(changedFiles) {
  const files = changedFiles || [];
  const schema = files.some((file) => file === "prisma/schema.prisma");
  const migrations = files.some((file) => file.startsWith("prisma/migrations/"));
  if (schema && !migrations)
    return { ok: false, reason: "schema_without_migration", schema, migrations };
  return { ok: true, schema, migrations };
}

export function changedFilesFromGit(baseRef = process.env.SCHEMA_COMPAT_BASE || "origin/main") {
  const attempts = [
    ["diff", "--name-only", `${baseRef}...HEAD`],
    ["diff", "--name-only", baseRef, "HEAD"],
  ];
  let lastError = null;
  for (const args of attempts) {
    try {
      const output = execFileSync("git", args, { encoding: "utf8" });
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function parsePrismaSchema(schemaText) {
  const enumNames = new Set();
  for (const match of String(schemaText).matchAll(/^enum\s+(\w+)\s*\{/gm)) {
    enumNames.add(match[1]);
  }
  const models = [];
  let current = null;
  let depth = 0;
  for (const raw of String(schemaText).split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!current) {
      const opening = line.match(/^model\s+(\w+)\s*\{/);
      if (!opening) continue;
      current = { model: opening[1], table: opening[1], columns: [] };
      depth = 1;
      continue;
    }
    if (line.startsWith("@@map")) {
      const mapped = line.match(/@@map\("([^"]+)"\)/);
      if (mapped) current.table = mapped[1];
    }
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
    if (depth <= 0) {
      models.push(current);
      current = null;
      continue;
    }
    if (!line || line.startsWith("@@") || line.startsWith("///")) continue;
    const field = line.match(/^(\w+)\s+([A-Za-z]\w*)(\[\])?(\?)?/);
    if (!field || field[3]) continue;
    const type = field[2];
    if (!SCALARS.has(type) && !enumNames.has(type)) continue;
    const mapped = line.match(/@map\("([^"]+)"\)/);
    current.columns.push({
      name: mapped ? mapped[1] : field[1],
      type: enumNames.has(type) ? "enum" : type,
      nullable: Boolean(field[4]),
    });
  }
  return models;
}

export function compareSchema(models, columns) {
  const byTable = new Map();
  for (const column of columns) {
    if (!byTable.has(column.table_name)) byTable.set(column.table_name, new Map());
    byTable.get(column.table_name).set(column.column_name, column);
  }
  const problems = [];
  for (const model of models) {
    const present = byTable.get(model.table);
    if (!present) {
      problems.push({ table: model.table, problem: "missing_table" });
      continue;
    }
    for (const column of model.columns) {
      const live = present.get(column.name);
      if (!live) {
        problems.push({ table: model.table, column: column.name, problem: "missing_column" });
        continue;
      }
      const allowed = COMPATIBLE[column.type];
      if (allowed && !allowed.has(live.data_type)) {
        problems.push({
          table: model.table,
          column: column.name,
          problem: "type_change",
          data_type: live.data_type,
        });
      }
    }
    for (const [name, live] of present) {
      if (model.columns.some((column) => column.name === name)) continue;
      if (live.is_nullable === "NO") {
        problems.push({ table: model.table, column: name, problem: "extra_not_null" });
      }
    }
  }
  return problems;
}

export function clientFromPool(pool) {
  return {
    async $queryRaw(strings, ...values) {
      let text = "";
      const params = [];
      strings.forEach((part, index) => {
        text += part;
        if (index < values.length) {
          params.push(values[index]);
          text += `$${params.length}`;
        }
      });
      const result = await pool.query(text, params);
      return result.rows;
    },
  };
}

export async function runApplicationReads(client) {
  resetSchemaCapabilitiesCache();
  const capabilities = await getSchemaCapabilities(client);
  await client.$queryRaw`SELECT "id", "userId", "scope", "periodType", "capUsd", "spentUsd" FROM "chief_budget" LIMIT 0`;
  await client.$queryRaw`SELECT "id", "approvalId", "state", "scopeHash" FROM "workforce_execution" LIMIT 0`;
  return { capabilities };
}

export async function executeRiskStatements(pool, statements) {
  const client = typeof pool.totalCount === "number" ? await pool.connect() : pool;
  const recorded = [];
  try {
    for (const sql of statements) {
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
        recorded.push({ sql, ok: true, error: null });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        recorded.push({
          sql,
          ok: false,
          error: String(error?.code || error?.message || "error"),
        });
      }
    }
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
  return recorded;
}

function quoteIdent(value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error("unsafe database name");
  }
  return `"${value}"`;
}

function databaseUrlFor(connectionString, database) {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

async function poolFor(connectionString) {
  const pg = (await import("pg")).default;
  const { buildPgPoolConfig } = await import("../server/db/pgPoolConfig.js");
  return new pg.Pool({
    ...buildPgPoolConfig(connectionString),
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
    max: 1,
  });
}

async function ensureDisposableIdentity(pool) {
  // Disposable setup only. Production bootstrap stays with the operator.
  // The empty ledger lets Prisma apply history on a database that also holds
  // the identity row. No migration is marked applied.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY NOT NULL,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS freedom_migration_identity (
      environment text NOT NULL,
      database_name text NOT NULL,
      migrate_role text NOT NULL
    )
  `);
  await pool.query(`DELETE FROM freedom_migration_identity`);
  await pool.query(`
    INSERT INTO freedom_migration_identity (environment, database_name, migrate_role)
    SELECT 'development', current_database(), current_user
  `);
}

function materializeProject(ref, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const args = ref
    ? ["archive", ref, "prisma/schema.prisma", "prisma/migrations", "prisma.config.ts"]
    : null;
  if (args) {
    const archive = execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", dest], { input: archive });
  } else {
    fs.cpSync("prisma/schema.prisma", path.join(dest, "prisma/schema.prisma"));
    fs.cpSync("prisma/migrations", path.join(dest, "prisma/migrations"), { recursive: true });
    fs.cpSync("prisma.config.ts", path.join(dest, "prisma.config.ts"));
  }
  if (!fs.existsSync(path.join(dest, "prisma.config.ts"))) {
    fs.cpSync("prisma.config.ts", path.join(dest, "prisma.config.ts"));
  }
  fs.symlinkSync(path.resolve("node_modules"), path.join(dest, "node_modules"));
}

async function migrateProject({ connectionString, projectDir, env }) {
  const childEnv = {
    ...env,
    DATABASE_URL: connectionString,
    DIRECT_URL: connectionString,
    CHIEF_MIGRATE_TARGET: "development",
    CHIEF_MIGRATE_LOCAL: "1",
    CHIEF_PROOF_MIGRATE: "1",
    VERCEL: "",
    VERCEL_ENV: "",
  };
  const pool = await poolFor(connectionString);
  try {
    await ensureDisposableIdentity(pool);
  } finally {
    await pool.end();
  }
  return deployMigrations({
    env: childEnv,
    cwd: projectDir,
    migrationsDir: path.join(projectDir, "prisma/migrations"),
  });
}

export async function runSchemaCompat({
  env = process.env,
  changedFiles = null,
  baseRef = env.SCHEMA_COMPAT_BASE || "origin/main",
  prepare = true,
} = {}) {
  const connectionString = (env.DIRECT_URL || env.DATABASE_URL || "").trim();
  if (!connectionString) return { ok: false, verified: false, reason: "database_missing" };
  const host = databaseHost(connectionString);
  if (prepare && !isLoopbackHost(host)) {
    return { ok: false, verified: false, reason: "not_loopback" };
  }
  const admin = await poolFor(databaseUrlFor(connectionString, "postgres"));
  let currentUser;
  try {
    const session = await admin.query("SELECT current_user AS user");
    currentUser = session.rows[0]?.user || "";
    const role = schemaCompatRoleAllowed(currentUser);
    if (!role.ok) return { ok: false, verified: false, reason: role.reason, currentUser };
    const files = changedFiles || changedFilesFromGit(baseRef);
    const diff = diffDecision(files);
    if (!diff.ok) return { ok: false, verified: false, reason: diff.reason, diff, currentUser };

    const manifest = loadHistoryManifest();
    const head = await classifyMigrationTree({ manifest });
    const migrate = automaticMigrate(head.files.filter((file) => !manifest.files[file.name]));
    const risks = head.files.filter((file) => file.class === "authorization-required");

    const stamp = `${process.pid}_${Date.now()}`;
    const baseName = `compat_base_${stamp}`;
    const headName = `compat_head_${stamp}`;
    await admin.query(`CREATE DATABASE ${quoteIdent(baseName)}`);
    await admin.query(`CREATE DATABASE ${quoteIdent(headName)}`);
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-compat-base-"));
    const headDir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-compat-head-"));
    try {
      materializeProject(baseRef, baseDir);
      materializeProject(null, headDir);
      const baseUrl = databaseUrlFor(connectionString, baseName);
      const headUrl = databaseUrlFor(connectionString, headName);
      const baseMigrate = await migrateProject({
        connectionString: baseUrl,
        projectDir: baseDir,
        env,
      });
      if (!baseMigrate.ok) {
        return {
          ok: false,
          verified: false,
          reason: "base_migrate_failed",
          detail: baseMigrate.reason,
          currentUser,
        };
      }
      const headMigrate = await migrateProject({
        connectionString: headUrl,
        projectDir: headDir,
        env,
      });
      if (!headMigrate.ok) {
        return {
          ok: false,
          verified: false,
          reason: "head_migrate_failed",
          detail: headMigrate.reason,
          currentUser,
        };
      }
      const basePool = await poolFor(baseUrl);
      let probes;
      try {
        probes = await runApplicationReads(clientFromPool(basePool));
        probes.budgetHold = await reserveHold({
          client: basePool,
          userId: "schema-compat",
          operationId: `schema-compat-${process.pid}`,
          scope: "cursor",
          periodType: "run",
          estimateUsd: 1,
        });
        if (probes.budgetHold?.ok) {
          return {
            ok: false,
            verified: false,
            reason: "budget_hold_not_closed",
            currentUser,
          };
        }
      } catch (error) {
        return {
          ok: false,
          verified: false,
          reason: "new_on_old_failed",
          detail: String(error?.message || error).slice(0, 300),
          currentUser,
        };
      } finally {
        await basePool.end();
      }
      const headPool = await poolFor(headUrl);
      let problems = [];
      let operational = [];
      try {
        const baseSchema = execFileSync("git", ["show", `${baseRef}:prisma/schema.prisma`], {
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        });
        const columns = await headPool.query(`
          SELECT table_name, column_name, is_nullable, data_type
          FROM information_schema.columns
          WHERE table_schema = 'public'
        `);
        problems = compareSchema(parsePrismaSchema(baseSchema), columns.rows);
        if (risks.length) {
          const statements = risks.map((file) =>
            fs.readFileSync(path.join("prisma/migrations", file.name, "migration.sql"), "utf8")
          );
          operational = await executeRiskStatements(headPool, statements);
        }
      } finally {
        await headPool.end();
      }
      if (problems.length) {
        return {
          ok: false,
          verified: false,
          reason: "old_on_new_failed",
          problems,
          currentUser,
          automatic_migrate: migrate,
        };
      }
      return {
        ok: true,
        verified: true,
        currentUser,
        diff,
        probes,
        automatic_migrate: migrate,
        operational_risk: operational,
        role: "all",
      };
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(baseName)} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(headName)} WITH (FORCE)`);
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.rmSync(headDir, { recursive: true, force: true });
    }
  } finally {
    await admin.end();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const roleArg = process.argv.find((arg) => arg.startsWith("--role="));
  const role = roleArg ? roleArg.slice("--role=".length) : "all";
  runSchemaCompat({ env: process.env })
    .then((result) => {
      const report = { ...result, requestedRole: role };
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      process.stderr.write(`[schema-compat] ${error.message}\n`);
      process.exit(1);
    });
}

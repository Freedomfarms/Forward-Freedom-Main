import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256 } from "../scripts/migration-classify.mjs";
import { evaluateMigrationIdentity } from "../scripts/migration-identity.mjs";
import { deployMigrations, parseAuthorizeArgs } from "../scripts/prisma-migrate-deploy.mjs";
import { databaseUrl, disposableAdminUrl } from "./disposable-postgres.js";

let adminUrlPromise;

function quoteIdent(value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error("unsafe ident");
  return `"${value}"`;
}

async function pg() {
  const client = (await import("pg")).default;
  return client;
}

async function adminQuery(sql, params = []) {
  const { Client } = await pg();
  const client = new Client({ connectionString: await adminUrl() });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function withDatabase(name, fn) {
  await adminQuery(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE ${quoteIdent(name)}`);
  const url = databaseUrl(await adminUrl(), name);
  try {
    return await fn(url);
  } finally {
    await adminQuery(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  }
}

function adminUrl() {
  adminUrlPromise ||= disposableAdminUrl();
  return adminUrlPromise;
}

function devEnv(url) {
  return {
    DATABASE_URL: url,
    DIRECT_URL: url,
    CHIEF_MIGRATE_TARGET: "development",
    CHIEF_MIGRATE_LOCAL: "1",
    PATH: process.env.PATH,
  };
}

async function identity(url, { environment = "development", role = null } = {}) {
  const { Client } = await pg();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE freedom_migration_identity (
        environment text NOT NULL,
        database_name text NOT NULL,
        migrate_role text NOT NULL
      )
    `);
    await client.query(`
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
    if (role) {
      await client.query(
        `INSERT INTO freedom_migration_identity (environment, database_name, migrate_role)
         VALUES ($1, current_database(), $2)`,
        [environment, role]
      );
    } else {
      await client.query(
        `INSERT INTO freedom_migration_identity (environment, database_name, migrate_role)
         SELECT $1, current_database(), current_user`,
        [environment]
      );
    }
  } finally {
    await client.end();
  }
}

function projectWith(migrations) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-gate-"));
  fs.mkdirSync(path.join(dir, "prisma/migrations"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "prisma/schema.prisma"),
    `generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n}\n\nmodel OkTable {\n  id String @id\n}\n`
  );
  fs.copyFileSync("prisma.config.ts", path.join(dir, "prisma.config.ts"));
  fs.copyFileSync(
    "prisma/migrations/migration_lock.toml",
    path.join(dir, "prisma/migrations/migration_lock.toml")
  );
  fs.symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"));
  for (const [name, sql] of Object.entries(migrations)) {
    const folder = path.join(dir, "prisma/migrations", name);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "migration.sql"), sql);
  }
  return dir;
}

test("identity mismatches do not count as permission to migrate", () => {
  const session = { migrate_role: "freedom_migrate_preview", database_name: "preview" };
  const row = [
    {
      environment: "preview",
      database_name: "preview",
      migrate_role: "freedom_migrate_preview",
    },
  ];
  assert.equal(
    evaluateMigrationIdentity({
      env: { CHIEF_MIGRATE_TARGET: "production", VERCEL_ENV: "preview", VERCEL: "1" },
      session,
      rows: row,
    }).reason,
    "target_mismatch"
  );
  assert.equal(
    evaluateMigrationIdentity({
      env: { CHIEF_MIGRATE_TARGET: "development" },
      session: { migrate_role: "chief_test", database_name: "app" },
      rows: [],
    }).reason,
    "identity_missing"
  );
  assert.equal(
    evaluateMigrationIdentity({
      env: { CHIEF_MIGRATE_TARGET: "development", CHIEF_MIGRATE_LOCAL: "1" },
      session: { migrate_role: "chief_test", database_name: "app" },
      rows: [{ environment: "development", database_name: "app", migrate_role: "other" }],
    }).reason,
    "role_mismatch"
  );
  assert.equal(
    evaluateMigrationIdentity({
      env: { CHIEF_MIGRATE_TARGET: "production" },
      session: { migrate_role: "freedom_migrate_production", database_name: "app" },
      rows: [
        {
          environment: "production",
          database_name: "app",
          migrate_role: "freedom_migrate_production",
        },
      ],
    }).reason,
    "off_vercel_target_refused"
  );
});

test("a denied pending migration does not spawn Prisma and a checksum releases the next file", async () => {
  const deniedSql = `DROP TABLE IF EXISTS "nope";\n`;
  const additiveSql = `CREATE TABLE "ok_table" ("id" TEXT PRIMARY KEY);\n`;
  const deniedName = "20990101000000_denied";
  const dir = projectWith({
    [deniedName]: deniedSql,
    "20990101000001_additive": additiveSql,
  });
  const digest = sha256(
    fs.readFileSync(path.join(dir, "prisma/migrations", deniedName, "migration.sql"))
  );
  await withDatabase("migrate_gate_release", async (url) => {
    await identity(url);
    let spawned = 0;
    const blocked = await deployMigrations({
      env: devEnv(url),
      cwd: dir,
      migrationsDir: path.join(dir, "prisma/migrations"),
      manifest: { baseline: "test", files: {} },
      spawnImpl: async () => {
        spawned += 1;
        return { code: 0, timedOut: false, error: null };
      },
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.spawned, false);
    assert.equal(spawned, 0);
    assert.equal(blocked.blocked.name, deniedName);
    assert.equal(blocked.blocked.sha256, digest);
    assert.match(blocked.command, new RegExp(`--authorize ${deniedName} --sha256 ${digest}`));
    const { Client } = await pg();
    const look = new Client({ connectionString: url });
    await look.connect();
    const absent = await look.query(`SELECT to_regclass('public.ok_table') AS name`);
    await look.end();
    assert.equal(absent.rows[0].name, null);

    const wrong = await deployMigrations({
      env: devEnv(url),
      cwd: dir,
      migrationsDir: path.join(dir, "prisma/migrations"),
      manifest: { baseline: "test", files: {} },
      authorize: { name: deniedName, sha256: "0".repeat(64) },
      spawnImpl: async () => {
        spawned += 1;
        return { code: 0, timedOut: false, error: null };
      },
    });
    assert.equal(wrong.reason, "authorization_checksum_mismatch");
    assert.equal(spawned, 0);

    const released = await deployMigrations({
      env: devEnv(url),
      cwd: dir,
      migrationsDir: path.join(dir, "prisma/migrations"),
      manifest: { baseline: "test", files: {} },
      authorize: { name: deniedName, sha256: digest },
    });
    assert.equal(released.ok, true, released.reason || "release failed");
    assert.equal(released.spawned, true);
    const check = new Client({ connectionString: url });
    await check.connect();
    const present = await check.query(`SELECT to_regclass('public.ok_table') AS name`);
    const history = await check.query(
      `SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name`
    );
    await check.end();
    assert.equal(present.rows[0].name, "ok_table");
    assert.deepEqual(
      history.rows.map((row) => row.migration_name),
      [deniedName, "20990101000001_additive"]
    );
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing identity row does not spawn Prisma", async () => {
  await withDatabase("migrate_gate_identity", async (url) => {
    let spawned = 0;
    const result = await deployMigrations({
      env: devEnv(url),
      manifest: { baseline: "test", files: {} },
      spawnImpl: async () => {
        spawned += 1;
        return { code: 0, timedOut: false, error: null };
      },
    });
    assert.equal(result.reason, "identity_missing");
    assert.equal(result.spawned, false);
    assert.equal(spawned, 0);
  });
});

test("the build script does not migrate and a bad authorization flag is refused", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts.build.includes("prisma:migrate:deploy"), false);
  assert.match(pkg.scripts.build, /prisma:generate/);
  assert.match(pkg.scripts.build, /vite build/);
  const source = fs.readFileSync("scripts/prisma-migrate-deploy.mjs", "utf8");
  assert.match(source, /never calls `prisma migrate resolve`/);
  assert.equal(source.includes('["migrate", "resolve"]'), false);
  assert.equal(source.includes("process.exit(result.ok ? 0 : 1)"), true);
  assert.equal(parseAuthorizeArgs(["--authorize", "dir"]).invalid, true);
});

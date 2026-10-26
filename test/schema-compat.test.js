import assert from "node:assert/strict";
import test from "node:test";

import { classifySql } from "../scripts/migration-classify.mjs";
import { schemaCompatRoleAllowed } from "../scripts/migration-identity.mjs";
import {
  clientFromPool,
  compareSchema,
  diffDecision,
  executeRiskStatements,
  parsePrismaSchema,
  runApplicationReads,
  runSchemaCompat,
} from "../scripts/schema-compat.mjs";
import { databaseUrl, disposableAdminUrl } from "./disposable-postgres.js";

test("a schema change without a migration is not compatible", () => {
  assert.equal(diffDecision(["prisma/schema.prisma"]).reason, "schema_without_migration");
  assert.equal(diffDecision(["src/main.jsx"]).ok, true);
  assert.equal(
    diffDecision(["prisma/schema.prisma", "prisma/migrations/1/migration.sql"]).ok,
    true
  );
});

test("old code fails when a base column is gone and ignores an extra nullable column", () => {
  const models = parsePrismaSchema(`
    model Note {
      id String @id
      body String
    }
  `);
  const missing = compareSchema(models, [
    { table_name: "Note", column_name: "id", is_nullable: "NO", data_type: "text" },
  ]);
  assert.equal(
    missing.some((item) => item.problem === "missing_column"),
    true
  );
  const extra = compareSchema(models, [
    { table_name: "Note", column_name: "id", is_nullable: "NO", data_type: "text" },
    { table_name: "Note", column_name: "body", is_nullable: "YES", data_type: "text" },
    { table_name: "Note", column_name: "extra", is_nullable: "YES", data_type: "text" },
  ]);
  assert.deepEqual(extra, []);
  const retyped = compareSchema(models, [
    { table_name: "Note", column_name: "id", is_nullable: "NO", data_type: "text" },
    { table_name: "Note", column_name: "body", is_nullable: "YES", data_type: "integer" },
  ]);
  assert.equal(
    retyped.some((item) => item.problem === "type_change"),
    true
  );
});

test("schema compatibility refuses the production and preview migrate roles", () => {
  assert.equal(schemaCompatRoleAllowed("freedom_migrate_production").ok, false);
  assert.equal(schemaCompatRoleAllowed("freedom_migrate_preview").ok, false);
  assert.equal(schemaCompatRoleAllowed("chief_test").ok, true);
});

test("application reads fail on an unhandled missing column, and a risk statement stays authorization-required", async () => {
  const { Client } = await import("pg");
  const adminUrl = await disposableAdminUrl();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS compat_probe WITH (FORCE)`);
  await admin.query(`CREATE DATABASE compat_probe`);
  await admin.end();
  const client = new Client({ connectionString: databaseUrl(adminUrl, "compat_probe") });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE "WorkspaceSnapshot" (id text);
      CREATE TABLE "chief_budget" (
        id text,
        "userId" text,
        scope text,
        "periodType" text,
        "capUsd" numeric,
        "spentUsd" numeric
      );
      CREATE TABLE "workforce_execution" (
        id text,
        "approvalId" text,
        state text
      );
    `);
    await assert.rejects(() => runApplicationReads(clientFromPool(client)));
    await client.query(`ALTER TABLE "workforce_execution" ADD COLUMN "scopeHash" text`);
    await client.query(`ALTER TABLE "WorkspaceSnapshot" ADD COLUMN "stateCiphertext" text`);
    const reads = await runApplicationReads(clientFromPool(client));
    assert.equal(reads.capabilities.encryptionColumns, true);

    const sql = `CREATE INDEX "chief_budget_scope_idx" ON "chief_budget" (scope);`;
    const classification = await classifySql(sql, { baseTables: new Set(["chief_budget"]) });
    assert.equal(classification.class, "authorization-required");
    const recorded = await executeRiskStatements(client, [sql]);
    assert.equal(recorded[0].ok, true);
    assert.equal(classification.class, "authorization-required");
    const duplicate = await executeRiskStatements(client, [sql]);
    assert.equal(duplicate[0].ok, false);
    assert.equal(classification.class, "authorization-required");
  } finally {
    await client.end();
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS compat_probe WITH (FORCE)`);
    await cleanup.end();
  }
});

test("schema-compat runs application reads on disposable Postgres and refuses a migrate role", async () => {
  const adminUrl = await disposableAdminUrl();
  const report = await runSchemaCompat({
    env: {
      ...process.env,
      DATABASE_URL: adminUrl,
      DIRECT_URL: adminUrl,
      CHIEF_MIGRATE_TARGET: "development",
      CHIEF_MIGRATE_LOCAL: "1",
      VERCEL: "",
      VERCEL_ENV: "",
    },
    changedFiles: [],
  });
  assert.equal(report.ok, true, report.reason || report.detail || "schema-compat failed");
  assert.equal(report.verified, true);
  assert.equal(report.probes.capabilities.encryptionColumns, true);
  assert.equal(report.automatic_migrate, "yes");

  const { Client } = await import("pg");
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'freedom_migrate_production') THEN
        CREATE ROLE freedom_migrate_production LOGIN PASSWORD 'freedom_migrate_production';
      END IF;
    END $$;
  `);
  await admin.query(`GRANT CONNECT ON DATABASE postgres TO freedom_migrate_production`);
  await admin.end();
  const refused = await runSchemaCompat({
    env: {
      DATABASE_URL: databaseUrl(adminUrl, "postgres").replace(
        /\/\/[^@]*@/,
        "//freedom_migrate_production:freedom_migrate_production@"
      ),
      DIRECT_URL: databaseUrl(adminUrl, "postgres").replace(
        /\/\/[^@]*@/,
        "//freedom_migrate_production:freedom_migrate_production@"
      ),
      CHIEF_MIGRATE_TARGET: "development",
      CHIEF_MIGRATE_LOCAL: "1",
    },
    changedFiles: [],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "migrate_role_refused");
});

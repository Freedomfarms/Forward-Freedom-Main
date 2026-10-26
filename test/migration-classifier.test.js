import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  authorizationCommand,
  classifyMigrationBytes,
  classifyMigrationTree,
  classifySql,
  loadHistoryManifest,
  sha256,
} from "../scripts/migration-classify.mjs";

const EXISTING = new Set(["User", "Account"]);

async function classified(sql, options = {}) {
  return classifySql(sql, { baseTables: EXISTING, baseTypes: new Set(["Mood"]), ...options });
}

test("a create table and an index on that new table are additive", async () => {
  const sql = `
    CREATE TABLE "widget" ("id" TEXT PRIMARY KEY, "name" TEXT);
    CREATE UNIQUE INDEX "widget_name_key" ON "widget" ("name");
  `;
  const result = await classified(sql);
  assert.equal(result.class, "additive");
});

test("a nullable column and a non-null column with a constant default are additive", async () => {
  const nullable = await classified(`ALTER TABLE "User" ADD COLUMN "note" TEXT;`);
  const constant = await classified(
    `ALTER TABLE "User" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;`
  );
  const stamped = await classified(
    `ALTER TABLE "User" ADD COLUMN "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;`
  );
  const uuid = await classified(
    `ALTER TABLE "User" ADD COLUMN "token" TEXT NOT NULL DEFAULT gen_random_uuid();`
  );
  const now = await classified(
    `ALTER TABLE "User" ADD COLUMN "seen" TIMESTAMP NOT NULL DEFAULT now();`
  );
  assert.equal(nullable.class, "additive");
  assert.equal(constant.class, "additive");
  assert.equal(stamped.class, "additive");
  assert.equal(uuid.class, "additive");
  assert.equal(now.class, "additive");
});

test("an index or foreign key on an existing table is authorization-required", async () => {
  const index = await classified(`CREATE INDEX "User_name_idx" ON "User" ("name");`);
  const unique = await classified(`CREATE UNIQUE INDEX "User_email_key" ON "User" ("email");`);
  const foreign = await classified(
    `ALTER TABLE "User" ADD CONSTRAINT "User_org_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id");`
  );
  assert.equal(index.class, "authorization-required");
  assert.equal(index.reason, "operational_risk");
  assert.equal(unique.class, "authorization-required");
  assert.equal(foreign.class, "authorization-required");
});

test("a foreign key inside the create table that introduces it stays additive", async () => {
  const result = await classified(`
    CREATE TABLE "child" (
      "id" TEXT,
      CONSTRAINT "child_org_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id")
    );
  `);
  assert.equal(result.class, "additive");
});

test("drop, row level security, and unrecognized statements are denied", async () => {
  const dropFile = fs.readFileSync(
    "prisma/migrations/20260708195911_privacy_field_encryption/migration.sql"
  );
  const rlsFile = fs.readFileSync(
    "prisma/migrations/20260718200000_freedom_os_row_level_security/migration.sql"
  );
  const drop = await classifySql(dropFile.toString("utf8"));
  const rls = await classifySql(rlsFile.toString("utf8"));
  const unknown = await classified(`VACUUM "User";`);
  assert.equal(drop.class, "denied");
  assert.equal(rls.class, "denied");
  assert.equal(unknown.class, "denied");
  assert.equal(unknown.reason, "VacuumStmt");
});

test("a parse error, an empty file, and a comment-only file are denied", async () => {
  assert.equal((await classified("NOT SQL AT ALL")).reason, "parse_error");
  assert.equal((await classified("")).reason, "empty");
  assert.equal((await classified("-- just a comment\n")).reason, "comment_only");
});

test("a drop hidden behind a comment is still denied", async () => {
  const hidden = await classified(`/* this is fine */\nDROP TABLE "User";`);
  const commented = await classified(`-- DROP TABLE "User";\n`);
  assert.equal(hidden.class, "denied");
  assert.equal(commented.class, "denied");
});

test("one denied statement denies an otherwise allowed file", async () => {
  const result = await classified(`
    CREATE TABLE "widget" ("id" TEXT);
    DROP TABLE "widget";
  `);
  assert.equal(result.class, "denied");
});

test("a string that contains a semicolon and DROP is not split into a second statement", async () => {
  const result = await classified(`
    CREATE TABLE "widget" ("id" TEXT, "note" TEXT DEFAULT 'a; DROP TABLE "User"');
  `);
  assert.equal(result.class, "additive");
  assert.equal(result.statements.length, 1);
});

test("set not null, drop not null, writes, grant, and concurrent indexes are denied", async () => {
  const samples = [
    `ALTER TABLE "User" ALTER COLUMN "note" SET NOT NULL;`,
    `ALTER TABLE "User" ALTER COLUMN "note" DROP NOT NULL;`,
    `ALTER TABLE "User" RENAME COLUMN "note" TO "notes";`,
    `ALTER TABLE "User" ALTER COLUMN "note" TYPE integer;`,
    `INSERT INTO "User" (id) VALUES ('a');`,
    `UPDATE "User" SET id = 'a';`,
    `DELETE FROM "User";`,
    `TRUNCATE "User";`,
    `GRANT SELECT ON "User" TO freedom_app;`,
    `REVOKE SELECT ON "User" FROM freedom_app;`,
    `DO $$ BEGIN NULL; END $$;`,
    `CREATE INDEX CONCURRENTLY "User_name_idx" ON "User" ("name");`,
    `ALTER TABLE "User" ADD COLUMN "n" INTEGER NOT NULL;`,
  ];
  for (const sql of samples) {
    const result = await classified(sql);
    assert.equal(result.class, "denied", sql);
  }
});

test("a historical file with a changed byte is denied and a matching byte may be replayed", async () => {
  const manifest = loadHistoryManifest();
  const name = "20260708195911_privacy_field_encryption";
  const bytes = fs.readFileSync(path.join("prisma/migrations", name, "migration.sql"));
  const match = await classifyMigrationBytes(bytes, { manifestSha: manifest.files[name] });
  assert.equal(match.class, "historical");
  const changed = Buffer.concat([bytes, Buffer.from(" ")]);
  const mismatch = await classifyMigrationBytes(changed, { manifestSha: manifest.files[name] });
  assert.equal(mismatch.class, "denied");
  assert.equal(mismatch.reason, "history_manifest_mismatch");
});

test("the committed manifest pins all 33 migrations at the phase 1 baseline", async () => {
  const manifest = loadHistoryManifest();
  assert.equal(manifest.baseline, "8f0610a862ccadb9cdaa9296209cc17cfe67d2a1");
  const names = fs
    .readdirSync("prisma/migrations")
    .filter((name) => fs.existsSync(path.join("prisma/migrations", name, "migration.sql")))
    .sort();
  assert.equal(names.length, 33);
  assert.deepEqual(Object.keys(manifest.files).sort(), names);
  for (const name of names) {
    const bytes = fs.readFileSync(path.join("prisma/migrations", name, "migration.sql"));
    assert.equal(manifest.files[name], sha256(bytes), name);
  }
  const tree = await classifyMigrationTree({ manifest });
  assert.equal(tree.blocked, null);
  assert.equal(
    tree.files.every((file) => file.class === "historical"),
    true
  );
});

test("a new non-additive file names the release command", async () => {
  const digest = sha256(Buffer.from(`DROP TABLE "User";`));
  assert.equal(
    authorizationCommand("20990101000000_example", digest),
    `node scripts/prisma-migrate-deploy.mjs --authorize 20990101000000_example --sha256 ${digest}`
  );
});

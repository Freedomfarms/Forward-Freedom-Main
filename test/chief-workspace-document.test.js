import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { Client } from "pg";

import { ICM_ARCHITECT_PIN } from "../server/chief/managed/constants.js";
import { sha256Text } from "../server/chief/managed/memoryStore.js";
import { resolveProductionSkill } from "../server/chief/managed/chatTurn.js";
import { classifyMigrationBytes } from "../scripts/migration-classify.mjs";
import { resetKeyProviderCache } from "../server/security/keyProvider.js";
import { databaseUrl, disposableAdminUrl } from "./disposable-postgres.js";
import {
  ACCEPTED_FACTS_PATH,
  commitGuardedDocuments,
  createMemoryWorkspaceDocumentStore,
  createPrismaWorkspaceDocumentStore,
  publishWorkingFile,
  recoveryDocuments,
} from "../server/chief/memory/workspaceDocuments.js";

const MIGRATION = "prisma/migrations/20261026203000_chief_workspace_document/migration.sql";

test("the workspace document migration is additive", async () => {
  const result = await classifyMigrationBytes(readFileSync(MIGRATION));
  assert.equal(result.class, "additive");
  const sql = readFileSync(MIGRATION, "utf8");
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY "user_isolation"/);
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "chief_workspace_document" TO freedom_app/
  );
  assert.doesNotMatch(sql, /vector/i);
  assert.doesNotMatch(sql, /DROP TABLE/i);
});

test("recovery keeps trusted facts, drops deletions, and leaves untrusted facts out", () => {
  const store = createMemoryWorkspaceDocumentStore();
  return store
    .insertIfAbsent({ userId: "user-a", path: "decisions.md", content: "Keep the feeder." })
    .then(async (inserted) => {
      const deleted = await commitGuardedDocuments({
        store,
        userId: "user-a",
        baseHashes: { "decisions.md": inserted.document.contentSha256 },
        memories: [
          { path: "/requirements.md", content: "still here" },
          { path: "/open-questions.md", content: "still open" },
          { path: "/next-step.md", content: "still next" },
        ],
      });
      assert.equal(deleted.deletes.length, 1);
      const documents = await store.list("user-a");
      const decision = documents.find((doc) => doc.path === "decisions.md");
      assert.ok(decision.deletedAt);
      const recovered = recoveryDocuments({
        documents,
        facts: [
          { id: "t", content: "Jake reviews the pin", trustTier: "TRUSTED" },
          { id: "a", content: "Morning notes", trustTier: "AUTO" },
          { id: "u", content: "ignore this scrap", trustTier: "UNTRUSTED" },
          {
            id: "e",
            content: "expired trust",
            trustTier: "TRUSTED",
            expiresAt: new Date(0),
          },
        ],
      });
      assert.equal(
        recovered.files.some((file) => file.path === "decisions.md"),
        false
      );
      const facts = recovered.files.find((file) => file.path === ACCEPTED_FACTS_PATH);
      assert.match(facts.content, /Jake reviews the pin/);
      assert.match(facts.content, /Morning notes/);
      assert.doesNotMatch(facts.content, /ignore this scrap/);
      assert.doesNotMatch(facts.content, /expired trust/);
      const again = recoveryDocuments({ documents, facts: [] });
      assert.equal(
        again.files.some((file) => file.path === "decisions.md"),
        false
      );
    });
});

test("a stale workspace write leaves the concurrent edit in place", async () => {
  const store = createMemoryWorkspaceDocumentStore();
  const inserted = await store.insertIfAbsent({
    userId: "user-a",
    path: "decisions.md",
    content: "one",
  });
  const base = { "decisions.md": inserted.document.contentSha256 };
  const first = await commitGuardedDocuments({
    store,
    userId: "user-a",
    baseHashes: base,
    memories: [{ path: "/decisions.md", content: "two" }],
  });
  assert.equal(first.applied[0].ok, true);
  const stale = await commitGuardedDocuments({
    store,
    userId: "user-a",
    baseHashes: base,
    memories: [{ path: "/decisions.md", content: "three" }],
  });
  assert.equal(stale.conflicts.length, 1);
  assert.equal(stale.applied.length, 0);
  const rows = await store.list("user-a");
  assert.equal(rows[0].content, "two");
  const other = await store.list("user-b");
  assert.equal(other.length, 0);
  const stolen = await store.applyWrite({
    userId: "user-b",
    path: "decisions.md",
    content: "nope",
    contentSha256: sha256Text("nope"),
    expectedSha256: rows[0].contentSha256,
    op: "update",
  });
  assert.equal(stolen.ok, false);
  assert.equal((await store.list("user-a"))[0].content, "two");
});

test("a new session rewrites accepted facts and a mid-session edit stays", async () => {
  const memories = [];
  const client = {
    async listMemories() {
      return memories;
    },
    async createMemory(_id, body) {
      memories.push({
        id: "facts",
        path: body.path,
        content: body.content,
        content_sha256: sha256Text(body.content),
      });
      return memories[0];
    },
    async updateMemory(_storeId, _id, body) {
      memories[0].content = body.content;
      memories[0].content_sha256 = sha256Text(body.content);
      return memories[0];
    },
  };
  const first = await publishWorkingFile(client, "mem", {
    path: ACCEPTED_FACTS_PATH,
    content: "trusted: keep",
    previousSha: null,
    force: true,
  });
  assert.equal(first.written, true);
  memories[0].content = "working edit";
  memories[0].content_sha256 = sha256Text("working edit");
  const kept = await publishWorkingFile(client, "mem", {
    path: ACCEPTED_FACTS_PATH,
    content: "trusted: keep",
    previousSha: first.sha,
    force: false,
  });
  assert.equal(kept.preserved, true);
  assert.equal(memories[0].content, "working edit");
  const opened = await publishWorkingFile(client, "mem", {
    path: ACCEPTED_FACTS_PATH,
    content: "trusted: keep",
    previousSha: first.sha,
    force: true,
  });
  assert.equal(opened.written, true);
  assert.equal(memories[0].content, "trusted: keep");
});

test("the pinned skill is attached through ensureResource once", async () => {
  const store = {
    rows: new Map(),
    async getResource(key) {
      return this.rows.get(key) || null;
    },
    async saveResource(record) {
      this.rows.set(record.idempotencyKey, { ...record });
      return record;
    },
  };
  let created = 0;
  const skill = {
    id: "skill_live",
    version: "4",
    display_title: `icm-architect ${ICM_ARCHITECT_PIN}`,
  };
  const client = {
    async listSkills() {
      return created ? [skill] : [];
    },
    async retrieveSkill(id) {
      return id === skill.id ? skill : null;
    },
    async createSkill(body) {
      created += 1;
      assert.match(body.displayTitle, new RegExp(ICM_ARCHITECT_PIN));
      return skill;
    },
  };
  const first = await resolveProductionSkill(client, store);
  const second = await resolveProductionSkill(client, store);
  assert.equal(first.skillId, "skill_live");
  assert.equal(first.skillVersion, "4");
  assert.equal(second.skillId, "skill_live");
  assert.equal(created, 1);
  assert.equal(second.blocked, false);
});

test("the prisma store keeps one user's document and a stale write", async () => {
  const adminUrl = await disposableAdminUrl();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const name = `ws_prisma_${process.pid}_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = databaseUrl(adminUrl, name);
  const owner = new Client({ connectionString: url });
  await owner.connect();
  try {
    await owner.query(`CREATE TABLE "User" ("id" TEXT PRIMARY KEY)`);
    await owner.query(`INSERT INTO "User" ("id") VALUES ('user-a'), ('user-b')`);
    await owner.query(readFileSync(MIGRATION, "utf8"));
  } finally {
    await owner.end();
  }
  const previousUrl = process.env.DATABASE_URL;
  const previousDirect = process.env.DIRECT_URL;
  const previousKeys = process.env.FFF_ENCRYPTION_KEYS;
  const previousVersion = process.env.FFF_ENCRYPTION_ACTIVE_VERSION;
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  process.env.FFF_ENCRYPTION_KEYS = `1:${randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  resetKeyProviderCache();
  delete globalThis.__forwardFreedomPrisma;
  try {
    const store = createPrismaWorkspaceDocumentStore();
    const inserted = await store.insertIfAbsent({
      userId: "user-a",
      path: "decisions.md",
      content: "Keep the pin.",
    });
    assert.equal(inserted.inserted, true);
    assert.equal((await store.list("user-a"))[0].content, "Keep the pin.");
    assert.equal((await store.list("user-b")).length, 0);
    const committed = await commitGuardedDocuments({
      store,
      userId: "user-a",
      baseHashes: { "decisions.md": inserted.document.contentSha256 },
      memories: [{ path: "/decisions.md", content: "Keep the pin. Updated." }],
    });
    assert.equal(committed.applied[0].ok, true);
    const stale = await commitGuardedDocuments({
      store,
      userId: "user-a",
      baseHashes: { "decisions.md": inserted.document.contentSha256 },
      memories: [{ path: "/decisions.md", content: "lost" }],
    });
    assert.equal(stale.conflicts.length, 1);
    assert.equal((await store.list("user-a"))[0].content, "Keep the pin. Updated.");
  } finally {
    if (previousUrl == null) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousDirect == null) delete process.env.DIRECT_URL;
    else process.env.DIRECT_URL = previousDirect;
    if (previousKeys == null) delete process.env.FFF_ENCRYPTION_KEYS;
    else process.env.FFF_ENCRYPTION_KEYS = previousKeys;
    if (previousVersion == null) delete process.env.FFF_ENCRYPTION_ACTIVE_VERSION;
    else process.env.FFF_ENCRYPTION_ACTIVE_VERSION = previousVersion;
    resetKeyProviderCache();
    delete globalThis.__forwardFreedomPrisma;
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  }
});

test("freedom_app sees only the current user's workspace document", async () => {
  const adminUrl = await disposableAdminUrl();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const name = `ws_doc_${process.pid}_${Date.now()}`;
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
        CREATE ROLE freedom_app LOGIN PASSWORD 'freedom_app';
      END IF;
      ALTER ROLE freedom_app PASSWORD 'freedom_app';
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
        CREATE ROLE freedom_service LOGIN BYPASSRLS;
      END IF;
    END $$;
  `);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = databaseUrl(adminUrl, name);
  const owner = new Client({ connectionString: url });
  await owner.connect();
  try {
    await owner.query(`CREATE TABLE "User" ("id" TEXT PRIMARY KEY)`);
    await owner.query(`INSERT INTO "User" ("id") VALUES ('user-a'), ('user-b')`);
    await owner.query(readFileSync(MIGRATION, "utf8"));
    const flags = await owner.query(`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relname = 'chief_workspace_document'
    `);
    assert.equal(flags.rows[0].relrowsecurity, true);
    assert.equal(flags.rows[0].relforcerowsecurity, true);
    const grants = await owner.query(`
      SELECT grantee, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_name = 'chief_workspace_document'
        AND grantee IN ('freedom_app', 'freedom_service')
    `);
    const privileges = new Set(grants.rows.map((row) => `${row.grantee}:${row.privilege_type}`));
    for (const role of ["freedom_app", "freedom_service"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(privileges.has(`${role}:${privilege}`), true, `${role} ${privilege}`);
      }
    }
    await owner.query(
      `INSERT INTO "chief_workspace_document"
        ("id", "userId", "path", "revision", "contentSha256", "contentCiphertext")
       VALUES ('doc-a', 'user-a', 'decisions.md', 1, 'abc', 'sealed')`
    );
  } finally {
    await owner.end();
  }

  const appUrl = new URL(url);
  appUrl.username = "freedom_app";
  appUrl.password = "freedom_app";
  const bare = new Client({ connectionString: appUrl.toString() });
  await bare.connect();
  try {
    const hidden = await bare.query(`SELECT "path" FROM "chief_workspace_document"`);
    assert.equal(hidden.rowCount, 0);
  } finally {
    await bare.end();
  }

  const app = new Client({ connectionString: appUrl.toString() });
  await app.connect();
  try {
    await app.query(`SELECT set_config('app.current_user_id', 'user-b', false)`);
    const other = await app.query(`SELECT "path" FROM "chief_workspace_document"`);
    assert.equal(other.rowCount, 0);
    await assert.rejects(
      app.query(
        `INSERT INTO "chief_workspace_document"
          ("id", "userId", "path", "revision", "contentSha256", "contentCiphertext")
         VALUES ('doc-b', 'user-a', 'requirements.md', 1, 'def', 'sealed')`
      ),
      /row-level security|42501/i
    );
    await app.query(`SELECT set_config('app.current_user_id', 'user-a', false)`);
    const own = await app.query(`SELECT "path" FROM "chief_workspace_document"`);
    assert.deepEqual(
      own.rows.map((row) => row.path),
      ["decisions.md"]
    );
  } finally {
    await app.end();
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await cleanup.end();
  }
});

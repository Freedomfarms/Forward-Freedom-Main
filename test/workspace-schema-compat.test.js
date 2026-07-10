import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { spawnSync } from "node:child_process";

// Proves the workspace API works against a database that has NOT received the
// privacy-encryption migration (the production failure mode after #104).
// Self-skips without DATABASE_URL / module mocks.

const HAS_DB = Boolean(process.env.DATABASE_URL);
const skip = !HAS_DB;
const DB_NAME = process.env.COMPAT_DB_NAME || "ff_compat";

let setupError = null;
let handler;
let prisma;

globalThis.__COMPAT_UID = "compat-user";

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
  };
}

function psql(...args) {
  return spawnSync("psql", ["-h", "/tmp", "-p", "5433", "-U", "postgres", "-d", DB_NAME, ...args], {
    encoding: "utf8",
  });
}

before(async () => {
  if (!HAS_DB) return;

  process.env.FFF_ENCRYPTION_KEYS =
    process.env.FFF_ENCRYPTION_KEYS || `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = process.env.FFF_ENCRYPTION_ACTIVE_VERSION || "1";

  class AuthError extends Error {
    constructor(message, status = 401) {
      super(message);
      this.name = "AuthError";
      this.status = status;
    }
  }
  const currentToken = () => ({
    uid: globalThis.__COMPAT_UID,
    email: `${globalThis.__COMPAT_UID}@example.com`,
    email_verified: true,
    name: "Compat User",
    picture: null,
  });

  try {
    mock.module("../server/auth/verifyAuth.js", {
      namedExports: {
        AuthError,
        readBearerToken: () => "test-token",
        authenticateRequest: async () => currentToken(),
        authenticateVerifiedRequest: async () => currentToken(),
      },
    });
  } catch (error) {
    setupError = error;
    return;
  }

  // Reset the DB to init-only (no encryption columns).
  spawnSync("createdb", ["-h", "/tmp", "-p", "5433", "-U", "postgres", DB_NAME], {
    encoding: "utf8",
  });
  const reset = psql("-c", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  if (reset.status !== 0) {
    setupError = new Error(reset.stderr || "failed to reset compat DB");
    return;
  }
  const init = psql("-f", "prisma/migrations/20250604120000_init/migration.sql");
  if (init.status !== 0) {
    setupError = new Error(init.stderr || "failed to apply init migration");
    return;
  }

  const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
  resetKeyProviderCache();
  const { resetSchemaCapabilitiesCache } = await import("../server/db/schemaCapabilities.js");
  resetSchemaCapabilitiesCache();

  handler = (await import("../api/workspace.js")).default;
  const { getPrismaClient } = await import("../server/db/prisma.js");
  prisma = getPrismaClient();

  // Narrow select: on this init-only (un-migrated) database the newer User
  // columns (e.g. legalConsentAt) do not exist, so a default upsert that
  // RETURNs every column would fail with P2022. Production code paths that
  // touch User on an un-migrated DB use the same narrow-select pattern.
  await prisma.user.upsert({
    where: { id: "compat-user" },
    update: {},
    create: { id: "compat-user", email: "compat-user@example.com" },
    select: { id: true },
  });
});

test("workspace GET works on an un-migrated (pre-encryption) database", { skip }, async (t) => {
  if (setupError) return t.skip(`setup failed: ${setupError.message}`);

  const res = mockRes();
  await handler({ method: "GET", query: {}, headers: {}, body: {} }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.snapshot, null);
});

test("workspace PUT then GET round-trips on an un-migrated database", { skip }, async (t) => {
  if (setupError) return t.skip(`setup failed: ${setupError.message}`);

  const state = {
    users: [{ id: "u1", name: "User 1", accounts: [], transactions: [], plaidItems: [] }],
    activeUserId: "u1",
  };

  const putRes = mockRes();
  await handler(
    { method: "PUT", query: {}, headers: {}, body: { state, source: "compat-test" } },
    putRes
  );
  assert.equal(putRes.statusCode, 200, JSON.stringify(putRes.body));
  assert.equal(putRes.body?.snapshot?.source, "compat-test");

  const getRes = mockRes();
  await handler({ method: "GET", query: {}, headers: {}, body: {} }, getRes);
  assert.equal(getRes.statusCode, 200, JSON.stringify(getRes.body));
  assert.equal(getRes.body?.snapshot?.state?.activeUserId, "u1");
  assert.equal(getRes.body?.snapshot?.state?.users?.[0]?.name, "User 1");

  // Confirm we wrote plaintext state (no ciphertext column exists).
  const row = await prisma.$queryRaw`SELECT state FROM "WorkspaceSnapshot" WHERE "userId" = ${"compat-user"}`;
  assert.ok(row?.[0]?.state);
  assert.equal(row[0].state.activeUserId, "u1");
});

import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { readdirSync } from "node:fs";

import { databaseUrlFor, readAdminTarget, runCreatedb, runPsql } from "./pg-admin.js";

// H-9: proves legal consent is enforced SERVER-SIDE (not just the client
// checkbox). A sensitive write is rejected until consent is recorded, consent
// is stored with an audit-trail row, and a legal-version bump forces re-accept.
//
// Runs against a REAL, fully-migrated Postgres. Self-skips unless:
//   • DATABASE_URL points at a reachable Postgres, and
//   • node was started with --experimental-test-module-mocks.

const HAS_DB = Boolean(process.env.DATABASE_URL);
const skip = !HAS_DB;

// psql and Prisma both use this database. It is not the shared DATABASE_URL
// database: several files reset schemas, and the suite runs them in parallel.
const DB_NAME = process.env.CONSENT_DB_NAME || "ff_consent";
const admin = readAdminTarget();

let setupError = null;
let meHandler;
let workspaceHandler;
let prisma;
let CURRENT_VERSION;

const UID = "consent-user";

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
  return runPsql(admin, { database: DB_NAME, args });
}

async function putWorkspace() {
  const res = mockRes();
  // Legacy path (no baseSnapshotUpdatedAt) so concurrency control never
  // interferes with what this test is asserting: the consent gate.
  await workspaceHandler(
    {
      method: "PUT",
      query: {},
      headers: {},
      body: {
        state: { users: [{ id: "u1", name: "User 1" }], activeUserId: "u1" },
        source: "consent-test",
        lastClientUpdatedAt: new Date().toISOString(),
      },
    },
    res
  );
  return res;
}

async function postConsent(version) {
  const res = mockRes();
  await meHandler(
    { method: "POST", query: {}, headers: {}, body: { legalConsent: { version, method: "test" } } },
    res
  );
  return res;
}

async function consentEventCount() {
  const rows = await prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM "LegalConsentEvent" WHERE "userId" = ${UID}`;
  return rows[0].n;
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
    uid: UID,
    email: `${UID}@example.com`,
    email_verified: true,
    name: "Consent User",
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

  runCreatedb(admin, DB_NAME);
  process.env.DATABASE_URL = databaseUrlFor(admin, DB_NAME);
  const reset = psql("-c", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  if (reset.status !== 0) {
    setupError = new Error(reset.stderr || "failed to reset consent DB");
    return;
  }
  // Every migration, in order, discovered dynamically so new migrations are
  // always part of this test's "fully-migrated" schema.
  const migrationDirs = readdirSync("prisma/migrations", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of migrationDirs) {
    const applied = psql("-f", `prisma/migrations/${dir}/migration.sql`);
    if (applied.status !== 0) {
      setupError = new Error(applied.stderr || `failed to apply ${dir}`);
      return;
    }
  }

  const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
  resetKeyProviderCache();
  const { resetSchemaCapabilitiesCache } = await import("../server/db/schemaCapabilities.js");
  resetSchemaCapabilitiesCache();
  ({ LEGAL_CONSENT_VERSION: CURRENT_VERSION } = await import("../src/content/legalContent.js"));

  meHandler = (await import("../api/me.js")).default;
  workspaceHandler = (await import("../api/workspace.js")).default;
  const { getPrismaClient } = await import("../server/db/prisma.js");
  prisma = getPrismaClient();

  // Seed a user WITHOUT any recorded consent.
  await prisma.user.create({ data: { id: UID, email: `${UID}@example.com` } });
});

test("workspace write is blocked with 403 until consent is recorded", { skip }, async (t) => {
  if (setupError) return t.skip(`setup failed: ${setupError.message}`);

  const blocked = await putWorkspace();
  assert.equal(blocked.statusCode, 403, JSON.stringify(blocked.body));
  assert.equal(blocked.body.requiresLegalConsent, true);
  assert.equal(blocked.body.requiredVersion, CURRENT_VERSION);
});

test("POST /api/me records consent + an audit-trail row, then writes succeed", { skip }, async (t) => {
  if (setupError) return t.skip(`setup failed: ${setupError.message}`);

  const before = await consentEventCount();

  const recorded = await postConsent(CURRENT_VERSION);
  assert.equal(recorded.statusCode, 200, JSON.stringify(recorded.body));
  assert.equal(recorded.body.user.legalConsentVersion, CURRENT_VERSION);
  assert.ok(recorded.body.user.legalConsentAt, "consent timestamp should be set");

  assert.equal(await consentEventCount(), before + 1, "one audit-trail row should be written");

  // GET returns the stored consent fields for the client to compare against.
  const getRes = mockRes();
  await meHandler({ method: "GET", query: {}, headers: {}, body: {} }, getRes);
  assert.equal(getRes.body.user.legalConsentVersion, CURRENT_VERSION);

  const allowed = await putWorkspace();
  assert.equal(allowed.statusCode, 200, JSON.stringify(allowed.body));
});

test("a legal-version bump forces re-acceptance", { skip }, async (t) => {
  if (setupError) return t.skip(`setup failed: ${setupError.message}`);

  // Simulate the deployed legal version moving ahead of the user's acceptance.
  await prisma.user.update({
    where: { id: UID },
    data: { legalConsentVersion: "0000-00-outdated" },
  });

  const blocked = await putWorkspace();
  assert.equal(blocked.statusCode, 403, JSON.stringify(blocked.body));
  assert.equal(blocked.body.requiresLegalConsent, true);
  assert.equal(blocked.body.requiredVersion, CURRENT_VERSION);

  // GET exposes the outdated version so the client knows to re-prompt.
  const getRes = mockRes();
  await meHandler({ method: "GET", query: {}, headers: {}, body: {} }, getRes);
  assert.equal(getRes.body.user.legalConsentVersion, "0000-00-outdated");

  const eventsBefore = await consentEventCount();
  const reaccepted = await postConsent(CURRENT_VERSION);
  assert.equal(reaccepted.statusCode, 200, JSON.stringify(reaccepted.body));
  assert.equal(await consentEventCount(), eventsBefore + 1, "re-acceptance appends history");

  const allowed = await putWorkspace();
  assert.equal(allowed.statusCode, 200, JSON.stringify(allowed.body));
});

test("POST /api/me rejects a consent payload with no version", { skip }, async (t) => {
  if (setupError) return t.skip(`setup failed: ${setupError.message}`);

  const res = mockRes();
  await meHandler({ method: "POST", query: {}, headers: {}, body: { legalConsent: {} } }, res);
  assert.equal(res.statusCode, 400, JSON.stringify(res.body));
});

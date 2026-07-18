import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// H-10: proves optimistic-concurrency control on workspace saves. Two clients
// load the same snapshot version; the first save wins and the second (based on
// the now-stale version) is rejected with 409 and handed the winning snapshot.
//
// Runs against a REAL, fully-migrated Postgres. Self-skips unless:
//   • DATABASE_URL points at a reachable Postgres, and
//   • node was started with --experimental-test-module-mocks.
//
// Run locally with:
//   DATABASE_URL=... FFF_ENCRYPTION_KEYS=1:<base64-32> \
//     node --test --experimental-test-module-mocks test/workspace-concurrency.test.js

const HAS_DB = Boolean(process.env.DATABASE_URL);
const skip = !HAS_DB;

// psql must target the SAME database Prisma connects to (DATABASE_URL), so the
// schema this test sets up is the schema the handlers run against.
function databaseNameFromUrl(fallback) {
  try {
    return new URL(process.env.DATABASE_URL).pathname.replace(/^\//, "") || fallback;
  } catch {
    return fallback;
  }
}
const DB_NAME = process.env.FULL_DB_NAME || databaseNameFromUrl("ff_full");
const PG_PORT = process.env.TEST_PG_PORT || "5433";

let setupError = null;
let handler;
let prisma;

const UID = "concurrency-user";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  return spawnSync("psql", ["-h", "/tmp", "-p", PG_PORT, "-U", "postgres", "-d", DB_NAME, ...args], {
    encoding: "utf8",
  });
}

async function putSnapshot({ state, source, baseSnapshotUpdatedAt }) {
  const res = mockRes();
  await handler(
    {
      method: "PUT",
      query: {},
      headers: {},
      body: { state, source, baseSnapshotUpdatedAt, lastClientUpdatedAt: new Date().toISOString() },
    },
    res
  );
  return res;
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
    name: "Concurrency User",
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

  // Fully-migrated schema: reset then apply every migration in order.
  spawnSync("createdb", ["-h", "/tmp", "-p", PG_PORT, "-U", "postgres", DB_NAME], {
    encoding: "utf8",
  });
  const reset = psql("-c", "DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  if (reset.status !== 0) {
    setupError = new Error(reset.stderr || "failed to reset full DB");
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
  const { LEGAL_CONSENT_VERSION } = await import("../src/content/legalContent.js");

  handler = (await import("../api/workspace.js")).default;
  const { getPrismaClient } = await import("../server/db/prisma.js");
  prisma = getPrismaClient();

  // Seed the user WITH current consent so workspace writes pass the H-9 gate.
  await prisma.user.create({
    data: {
      id: UID,
      email: `${UID}@example.com`,
      legalConsentAt: new Date(),
      legalConsentVersion: LEGAL_CONSENT_VERSION,
    },
  });
});

test("stale save is rejected with 409 and the winning snapshot is returned", { skip }, async (t) => {
  if (setupError) return t.skip(`setup failed: ${setupError.message}`);

  const baseState = { users: [{ id: "u1", name: "User 1" }], activeUserId: "u1" };

  // Initial create (no snapshot yet) → version X.
  const createRes = await putSnapshot({ state: baseState, source: "create", baseSnapshotUpdatedAt: null });
  assert.equal(createRes.statusCode, 200, JSON.stringify(createRes.body));
  const versionX = createRes.body.snapshot.updatedAt;
  assert.ok(versionX, "create should return an updatedAt version token");

  // Both clients loaded version X. Space the winning write so its updatedAt is
  // strictly newer than X (TIMESTAMP(3) is millisecond resolution).
  await sleep(5);

  // Client A saves on top of X → succeeds, producing version Y.
  const aState = { users: [{ id: "u1", name: "Edited by A" }], activeUserId: "u1" };
  const aRes = await putSnapshot({ state: aState, source: "client-a", baseSnapshotUpdatedAt: versionX });
  assert.equal(aRes.statusCode, 200, JSON.stringify(aRes.body));
  const versionY = aRes.body.snapshot.updatedAt;
  assert.notDeepEqual(versionY, versionX, "A's save should advance the version");

  // Client B saves using the now-stale version X → rejected with 409.
  const bState = { users: [{ id: "u1", name: "Edited by B" }], activeUserId: "u1" };
  const bRes = await putSnapshot({ state: bState, source: "client-b", baseSnapshotUpdatedAt: versionX });
  assert.equal(bRes.statusCode, 409, JSON.stringify(bRes.body));
  assert.equal(bRes.body.error, true);
  assert.equal(bRes.body.requiresLegalConsent ?? false, false);

  // The 409 returns the winning snapshot (A's data), not B's.
  assert.equal(bRes.body.snapshot.state.users[0].name, "Edited by A");
  assert.deepEqual(bRes.body.snapshot.updatedAt, versionY);

  // The database still holds A's write; B never overwrote it.
  const getRes = mockRes();
  await handler({ method: "GET", query: {}, headers: {}, body: {} }, getRes);
  assert.equal(getRes.body.snapshot.state.users[0].name, "Edited by A");
});

test("a save based on the current version succeeds", { skip }, async (t) => {
  if (setupError) return t.skip(`setup failed: ${setupError.message}`);

  const getRes = mockRes();
  await handler({ method: "GET", query: {}, headers: {}, body: {} }, getRes);
  const currentVersion = getRes.body.snapshot.updatedAt;

  await sleep(5);
  const nextState = { users: [{ id: "u1", name: "Fresh edit" }], activeUserId: "u1" };
  const res = await putSnapshot({
    state: nextState,
    source: "fresh",
    baseSnapshotUpdatedAt: currentVersion,
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.snapshot.state.users[0].name, "Fresh edit");
  assert.notDeepEqual(res.body.snapshot.updatedAt, currentVersion);
});

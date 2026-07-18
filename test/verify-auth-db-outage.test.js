import test, { before, mock } from "node:test";
import assert from "node:assert/strict";

// Regression test for the RLS-rollout incident where a database connection
// failure during the auth-time disabled-account lookup surfaced to the client
// as a 401 carrying the raw driver error ("(ESSLREQUIRED) SSL connection is
// required for user: postgres"). Infrastructure failures must be reported as
// 503 with a stable message; only token verification failures may 401.
//
// Requires: node --test --experimental-test-module-mocks

const HAS_MODULE_MOCKS = typeof mock.module === "function";
const skip = !HAS_MODULE_MOCKS;

const DB_ERROR_MESSAGE = "(ESSLREQUIRED) SSL connection is required for user: postgres";

// Toggled per test to drive the mocked layers.
globalThis.__VERIFY_AUTH_TEST = {
  verifyIdTokenError: null,
  dbError: null,
  userRecord: null,
};

let authenticateRequest;
let AuthError;

before(async () => {
  if (skip) return;

  mock.module("../server/auth/firebaseAdmin.js", {
    namedExports: {
      isFirebaseAdminConfigured: () => true,
      getFirebaseAdminAuth: () => ({
        verifyIdToken: async () => {
          const { verifyIdTokenError } = globalThis.__VERIFY_AUTH_TEST;
          if (verifyIdTokenError) throw verifyIdTokenError;
          return { uid: "user-1", email: "user-1@example.com" };
        },
      }),
    },
  });

  mock.module("../server/db/prisma.js", {
    namedExports: {
      isDatabaseConfigured: () => true,
      getPrismaClient: () => ({}),
      withUserContext: async (userId, fn) => {
        const { dbError, userRecord } = globalThis.__VERIFY_AUTH_TEST;
        if (dbError) throw dbError;
        return fn({ user: { findUnique: async () => userRecord } });
      },
      Prisma: {},
    },
  });

  ({ authenticateRequest, AuthError } = await import("../server/auth/verifyAuth.js"));
});

function requestWithToken() {
  return { headers: { authorization: "Bearer test-token" } };
}

test("a database outage during the disabled-account lookup is a 503, not a 401", { skip }, async () => {
  globalThis.__VERIFY_AUTH_TEST = {
    verifyIdTokenError: null,
    dbError: new Error(DB_ERROR_MESSAGE),
    userRecord: null,
  };

  await assert.rejects(
    () => authenticateRequest(requestWithToken()),
    (thrown) => {
      assert.ok(thrown instanceof AuthError);
      assert.equal(thrown.status, 503);
      // The raw driver error (connection details, usernames) must never
      // reach the client-facing message.
      assert.equal(thrown.message.includes("ESSLREQUIRED"), false);
      assert.equal(thrown.message.includes("postgres"), false);
      return true;
    }
  );
});

test("an invalid Firebase token still fails with 401", { skip }, async () => {
  globalThis.__VERIFY_AUTH_TEST = {
    verifyIdTokenError: new Error("Firebase ID token has expired."),
    dbError: null,
    userRecord: null,
  };

  await assert.rejects(
    () => authenticateRequest(requestWithToken()),
    (thrown) => {
      assert.ok(thrown instanceof AuthError);
      assert.equal(thrown.status, 401);
      return true;
    }
  );
});

test("a disabled account still fails with 403", { skip }, async () => {
  globalThis.__VERIFY_AUTH_TEST = {
    verifyIdTokenError: null,
    dbError: null,
    userRecord: { isDisabled: true },
  };

  await assert.rejects(
    () => authenticateRequest(requestWithToken()),
    (thrown) => {
      assert.ok(thrown instanceof AuthError);
      assert.equal(thrown.status, 403);
      return true;
    }
  );
});

test("a healthy lookup returns the decoded token", { skip }, async () => {
  globalThis.__VERIFY_AUTH_TEST = {
    verifyIdTokenError: null,
    dbError: null,
    userRecord: { isDisabled: false },
  };

  const decoded = await authenticateRequest(requestWithToken());
  assert.equal(decoded.uid, "user-1");
});

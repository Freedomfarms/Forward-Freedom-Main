import test, { before, mock } from "node:test";
import assert from "node:assert/strict";

import { createRequest, createResponse } from "./helpers/httpMocks.js";

class FakeAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

const users = new Map();

function fakeReadBearerToken(request) {
  const header = request?.headers?.authorization || "";
  const match = /^Bearer\s+(.+)$/.exec(String(header).trim());
  return match?.[1] || null;
}

let handler;

before(async () => {
  mock.module("../server/auth/verifyAuth.js", {
    namedExports: {
      AuthError: FakeAuthError,
      readBearerToken: fakeReadBearerToken,
      authenticateRequest: async (request) => {
        const uid = fakeReadBearerToken(request);
        if (!uid) throw new FakeAuthError("Missing bearer token.", 401);
        return { uid, email: `${uid}@example.com`, email_verified: true, name: "Ada" };
      },
    },
  });

  mock.module("../server/db/prisma.js", {
    namedExports: {
      withUserContext: async (userId, fn) =>
        fn({
          user: {
            upsert: async ({ where, update, create, select }) => {
              const existing = users.get(where.id) || null;
              const next = existing
                ? { ...existing, ...update, id: where.id }
                : { role: "OWNER", isDisabled: false, isAdmin: null, ...create };
              users.set(where.id, next);
              if (select) {
                const picked = {};
                for (const key of Object.keys(select)) {
                  if (select[key]) picked[key] = next[key] ?? null;
                }
                return picked;
              }
              return next;
            },
          },
        }),
      getPrismaClient: () => ({}),
      isDatabaseConfigured: () => true,
    },
  });

  mock.module("../server/http/rateLimit.js", {
    namedExports: {
      enforceRateLimit: async () => true,
      generalApiRateLimit: {},
    },
  });

  handler = (await import("../api/me.js")).default;
});

function authed(method, body) {
  return createRequest({
    method,
    headers: { authorization: "Bearer user-1" },
    ...(body !== undefined ? { body } : {}),
  });
}

test("GET /api/me reads User.timezone", async () => {
  users.set("user-1", {
    id: "user-1",
    email: "user-1@example.com",
    timezone: "America/Chicago",
    isAdmin: null,
    role: "OWNER",
  });
  const response = createResponse();
  await handler(authed("GET"), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.timezone, "America/Chicago");
});

test("PATCH /api/me writes a valid User.timezone", async () => {
  const response = createResponse();
  await handler(authed("PATCH", { timezone: "  America/Denver " }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.user.timezone, "America/Denver");
  assert.equal(users.get("user-1").timezone, "America/Denver");
});

test("PATCH /api/me rejects an invalid timezone without AgentError", async () => {
  const response = createResponse();
  await handler(authed("PATCH", { timezone: "Mars/Olympus" }), response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, true);
  assert.equal(response.body.code, "INVALID_TIMEZONE");
  assert.match(response.body.message, /IANA timezone/);
});

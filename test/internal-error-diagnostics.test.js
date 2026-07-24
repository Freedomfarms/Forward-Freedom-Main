import test from "node:test";
import assert from "node:assert/strict";

import { respondInternalError } from "../server/http/errorHelpers.js";

// Workspace / Plaid 500s used to return a stable message with no hint of the
// underlying failure. During the RLS role switch that hid "permission denied"
// and similar connection-config mistakes behind "Unable to read or update the
// workspace snapshot." respondInternalError now appends describeDatabaseError.

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("respondInternalError appends a redacted database diagnostic", () => {
  process.env.DATABASE_URL =
    "postgresql://freedom_app.abcdefghij:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";

  const driverError = Object.assign(new Error('permission denied for table WorkspaceSnapshot'), {
    code: "42501",
  });
  const response = mockRes();
  respondInternalError(response, "api/workspace", driverError, "Unable to read or update the workspace snapshot.");

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error, true);
  assert.equal(
    response.body.message.startsWith("Unable to read or update the workspace snapshot."),
    true
  );
  assert.equal(response.body.message.includes("role freedom_app"), true);
  assert.equal(response.body.message.includes("code 42501"), true);
  assert.equal(response.body.message.includes("permission denied"), true);
});

test("respondInternalError keeps the stable message when there is nothing useful to add", () => {
  process.env.DATABASE_URL = "not-a-url";
  const response = mockRes();
  respondInternalError(response, "api/workspace", null, "Unable to read or update the workspace snapshot.");

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.message, "Unable to read or update the workspace snapshot.");
});

test("respondInternalError does not label LLM failures as role freedom_app", () => {
  process.env.DATABASE_URL =
    "postgresql://freedom_app.abcdefghij:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
  const response = mockRes();
  respondInternalError(
    response,
    "api/agents/ceo/chat",
    new Error("Grammar compilation timed out."),
    "Unable to process the CEO Agent chat message."
  );

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.message, "Unable to process the CEO Agent chat message.");
  assert.equal(response.body.message.includes("freedom_app"), false);
});

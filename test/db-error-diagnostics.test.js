import test from "node:test";
import assert from "node:assert/strict";

import { describeDatabaseError } from "../server/db/describeDatabaseError.js";

// The 503 "database unreachable" path attaches this summary so that during a
// rollout, connection-config mistakes (wrong Supavisor username, bad password,
// missing grants, SSL enforcement) are identifiable from the UI. It must
// report the configured role WITHOUT the .<project-ref> tenant suffix, dig
// through Prisma cause chains / pg AggregateErrors for the real driver error,
// and pass everything through the redaction layer.

const ENV = {
  DATABASE_URL:
    "postgresql://freedom_app.abcdefghij:s3cret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
};

test("reports role (without tenant suffix), code, and the deepest driver message", () => {
  const driverError = Object.assign(
    new Error('password authentication failed for user "freedom_app.abcdefghij"'),
    { code: "28P01" }
  );
  const wrapped = new Error("Database query failed");
  wrapped.cause = driverError;

  const summary = describeDatabaseError(wrapped, ENV);
  assert.equal(summary.includes("role freedom_app"), true);
  assert.equal(summary.includes(".abcdefghij —"), false);
  assert.equal(summary.includes("code 28P01"), true);
  assert.equal(summary.includes("password authentication failed"), true);
  // The password from DATABASE_URL must never appear.
  assert.equal(summary.includes("s3cret"), false);
});

test("unwraps pg AggregateError connection failures", () => {
  const aggregate = new AggregateError(
    [Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:6543"), { code: "ECONNREFUSED" })],
    "All connection attempts failed"
  );

  const summary = describeDatabaseError(aggregate, ENV);
  assert.equal(summary.includes("code ECONNREFUSED"), true);
  assert.equal(summary.includes("ECONNREFUSED 1.2.3.4:6543"), true);
});

test("keeps only the first line of multi-line driver messages", () => {
  const error = Object.assign(new Error("Tenant or user not found\n  at Object.query (...)"), {
    code: "XX000",
  });

  const summary = describeDatabaseError(error, ENV);
  assert.equal(summary.includes("Tenant or user not found"), true);
  assert.equal(summary.includes("at Object.query"), false);
});

test("survives malformed DATABASE_URL and errors without code or cause", () => {
  const summary = describeDatabaseError(new Error("boom"), { DATABASE_URL: "not a url" });
  assert.equal(summary.includes("boom"), true);
  assert.equal(summary.includes("role"), false);
});

test("scrubs embedded secrets through the redaction layer", () => {
  const error = new Error(
    "request failed with Bearer eyJhbGciOi.payload.signature attached somewhere"
  );

  const summary = describeDatabaseError(error, ENV);
  assert.equal(summary.includes("eyJhbGciOi"), false);
});

test("never throws from diagnostics", () => {
  assert.equal(typeof describeDatabaseError(null, ENV), "string");
  assert.equal(typeof describeDatabaseError(undefined, {}), "string");
  const circular = new Error("circular");
  circular.cause = circular;
  assert.equal(describeDatabaseError(circular, ENV).includes("circular"), true);
});

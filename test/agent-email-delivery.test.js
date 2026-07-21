import test, { before, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Unit tests for the shared email delivery module: enable/detect helpers and
// the fail-closed gating (no email service, unverifiable address). The real
// Resend API and Firebase Admin are never reached.
//
// Requires: node --test --experimental-test-module-mocks (npm test).

let setupError = null;
let emailDelivery;
let firebaseUserRecord;
let firebaseConfigured;

before(async () => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";

  try {
    mock.module("../server/auth/firebaseAdmin.js", {
      namedExports: {
        isFirebaseAdminConfigured: () => firebaseConfigured,
        getFirebaseAdminApp: () => (firebaseConfigured ? {} : null),
        getFirebaseAdminAuth: () =>
          firebaseConfigured
            ? {
                getUser: async () => {
                  if (firebaseUserRecord instanceof Error) throw firebaseUserRecord;
                  return firebaseUserRecord;
                },
              }
            : null,
      },
    });
    mock.module("../server/db/prisma.js", {
      namedExports: {
        withUserContext: async () => {
          throw new Error("not used in these tests");
        },
        getPrismaClient: () => null,
        isDatabaseConfigured: () => false,
        Prisma: {},
      },
    });
    emailDelivery = await import("../server/agents/emailDelivery.js");
  } catch (error) {
    setupError = error;
  }
});

function requireSetup(t) {
  if (setupError) {
    t.skip(`requires --experimental-test-module-mocks (${setupError.message})`);
    return false;
  }
  return true;
}

test("isEmailDeliveryEnabled accepts both stored shapes", (t) => {
  if (!requireSetup(t)) return;
  assert.equal(emailDelivery.isEmailDeliveryEnabled({ email: true }), true);
  assert.equal(emailDelivery.isEmailDeliveryEnabled(["email"]), true);
  assert.equal(emailDelivery.isEmailDeliveryEnabled({ email: false }), false);
  assert.equal(emailDelivery.isEmailDeliveryEnabled(null), false);
  assert.equal(emailDelivery.isEmailDeliveryEnabled({}), false);
});

test("isEmailReportRequest detects email-me phrasings and avoids mentions", (t) => {
  if (!requireSetup(t)) return;
  const { isEmailReportRequest } = emailDelivery;
  assert.equal(isEmailReportRequest("email me the report"), true);
  assert.equal(isEmailReportRequest("can you email me a draft?"), true);
  assert.equal(isEmailReportRequest("please email the latest summary"), true);
  assert.equal(isEmailReportRequest("send me the findings by email"), true);
  assert.equal(isEmailReportRequest("send the report to my email"), true);
  // Mentions of email that are not send requests must NOT trigger a send.
  assert.equal(isEmailReportRequest("does the report include email addresses?"), false);
  assert.equal(isEmailReportRequest("what's your email policy?"), false);
  assert.equal(isEmailReportRequest("summarize my spending"), false);
});

test("sendAgentReportEmail skips when the email service is not configured", async (t) => {
  if (!requireSetup(t)) return;
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  t.after(() => {
    if (previous == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous;
  });

  firebaseConfigured = true;
  firebaseUserRecord = { email: "user@example.com", emailVerified: true };
  const result = await emailDelivery.sendAgentReportEmail({
    userId: "u1",
    subject: "s",
    body: "b",
  });
  assert.equal(result.sent, false);
  assert.match(result.status, /email service is not configured/);
});

test("sendAgentReportEmail fails closed when verification cannot be confirmed", async (t) => {
  if (!requireSetup(t)) return;
  const previous = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "test-key-never-used";
  t.after(() => {
    if (previous == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous;
  });

  // Unverified address → skipped.
  firebaseConfigured = true;
  firebaseUserRecord = { email: "user@example.com", emailVerified: false };
  let result = await emailDelivery.sendAgentReportEmail({ userId: "u1", subject: "s", body: "b" });
  assert.equal(result.sent, false);
  assert.match(result.status, /not verified/);

  // No email on the account → skipped.
  firebaseUserRecord = { email: null, emailVerified: false };
  result = await emailDelivery.sendAgentReportEmail({ userId: "u1", subject: "s", body: "b" });
  assert.equal(result.sent, false);
  assert.match(result.status, /no email address/);

  // Lookup failure → skipped (fail closed).
  firebaseUserRecord = new Error("firebase down");
  result = await emailDelivery.sendAgentReportEmail({ userId: "u1", subject: "s", body: "b" });
  assert.equal(result.sent, false);
  assert.match(result.status, /could not be looked up/);

  // Admin SDK not configured at all → skipped (fail closed).
  firebaseConfigured = false;
  result = await emailDelivery.sendAgentReportEmail({ userId: "u1", subject: "s", body: "b" });
  assert.equal(result.sent, false);
  assert.match(result.status, /auth service is not configured/);
});

test("sendAgentReportEmailOrThrow raises typed errors for API endpoints", async (t) => {
  if (!requireSetup(t)) return;
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  t.after(() => {
    if (previous == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previous;
  });

  await assert.rejects(
    () => emailDelivery.sendAgentReportEmailOrThrow({ userId: "u1", subject: "s", body: "b" }),
    (error) => error.code === "EMAIL_SERVICE_UNAVAILABLE" && error.status === 503
  );

  process.env.RESEND_API_KEY = "test-key-never-used";
  firebaseConfigured = true;
  firebaseUserRecord = { email: "user@example.com", emailVerified: false };
  await assert.rejects(
    () => emailDelivery.sendAgentReportEmailOrThrow({ userId: "u1", subject: "s", body: "b" }),
    (error) => error.code === "EMAIL_NOT_VERIFIED" && error.status === 403
  );
});

test("buildRunEmailContent includes summary, report, and the safety footer", (t) => {
  if (!requireSetup(t)) return;
  const { subject, body } = emailDelivery.buildRunEmailContent({
    agentName: "Market Research",
    agentType: "research",
    run: { summary: "Prices rose.", startedAt: new Date("2026-07-20T13:00:00Z") },
    output: "Full report text.",
  });
  assert.match(subject, /Market Research/);
  assert.match(subject, /report/);
  assert.match(body, /Summary:\nPrices rose\./);
  assert.match(body, /Report:\nFull report text\./);
  assert.match(body, /only email you, never anyone else/i);
});

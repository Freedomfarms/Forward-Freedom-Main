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
  assert.equal(isEmailReportRequest("can you send email now so i can see draft?"), true);
  // Mentions of email that are not send requests must NOT trigger a send.
  assert.equal(isEmailReportRequest("does the report include email addresses?"), false);
  assert.equal(isEmailReportRequest("what's your email policy?"), false);
  assert.equal(isEmailReportRequest("summarize my spending"), false);
  assert.equal(isEmailReportRequest("enable email after each run"), false);
  assert.equal(isEmailReportRequest("disable email"), false);
  // Status questions must never short-circuit into a send.
  assert.equal(isEmailReportRequest("Did you email this run or did you just run it?"), false);
  assert.equal(isEmailReportRequest("Have you emailed the report?"), false);
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

  // Unverified address → skipped with verify-first guidance.
  firebaseConfigured = true;
  firebaseUserRecord = { email: "user@example.com", emailVerified: false };
  let result = await emailDelivery.sendAgentReportEmail({ userId: "u1", subject: "s", body: "b" });
  assert.equal(result.sent, false);
  assert.match(result.status, /verify your account email first/i);
  assert.match(result.status, /u\*\*\*@example\.com/);
  assert.match(result.status, /never the site address/i);

  // No email on the account → skipped.
  firebaseUserRecord = { email: null, emailVerified: false };
  result = await emailDelivery.sendAgentReportEmail({ userId: "u1", subject: "s", body: "b" });
  assert.equal(result.sent, false);
  assert.match(result.status, /add and verify an email/i);

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
    (error) =>
      error.code === "EMAIL_NOT_VERIFIED" &&
      error.status === 403 &&
      /verify your account email first/i.test(error.message) &&
      /never the site address/i.test(error.message)
  );
});

test("Resend domain errors are explained as sending-domain setup, not recipient", (t) => {
  if (!requireSetup(t)) return;
  const status = emailDelivery.describeEmailDeliveryFailure(
    "The forwardfreedomfinancial.com domain is not verified. Please, add and verify your domain on https://resend.com/domains",
    "owner@gmail.com"
  );
  assert.match(status, /o\*\*\*@gmail\.com/);
  assert.match(status, /sending domain/i);
  assert.match(status, /not the site address/i);
  assert.doesNotMatch(status, /email delivery failed \(The forwardfreedomfinancial/);
});

test("maskEmailAddress keeps domain and hides local part", (t) => {
  if (!requireSetup(t)) return;
  assert.equal(emailDelivery.maskEmailAddress("alex@example.com"), "a***@example.com");
  assert.equal(emailDelivery.maskEmailAddress(""), "your account email");
});

test("buildRunEmailContent builds subject, HTML, and text fallback", (t) => {
  if (!requireSetup(t)) return;
  const { subject, body, html } = emailDelivery.buildRunEmailContent({
    agentName: "Market Research",
    agentType: "research",
    run: { summary: "Prices **rose**.", startedAt: new Date("2026-07-20T13:00:00Z") },
    output: "## Findings\n\nPrices went **up** ([source](https://example.com)).\n\n## Summary\n\nPrices rose.",
  });

  // Subject: "<agent name> — <formatted date>", no boilerplate.
  assert.equal(subject, "Market Research — Monday, July 20");

  // HTML: branded template + rendered markdown + summary callout + footer.
  assert.match(html, /Freedom OS/);
  assert.match(html, /Research Brief/);
  assert.match(html, /Monday, July 20/);
  assert.match(html, /<h2[^>]*>Findings<\/h2>/);
  assert.match(html, /<strong[^>]*>up<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /Summary<\/div>/); // callout label
  assert.match(html, /Prices <strong[^>]*>rose<\/strong>\./); // callout content
  assert.match(html, /only email you, never anyone else/i);

  // Text fallback: markdown syntax stripped, old Summary:/Report: labels gone.
  assert.match(body, /^Market Research — Monday, July 20/);
  assert.match(body, /Findings\n\nPrices went up \(source \(https:\/\/example\.com\)\)/);
  assert.doesNotMatch(body, /Report:/);
  assert.doesNotMatch(body, /\*\*/);
  assert.match(body, /only email you, never anyone else/i);
});

test("buildRunEmailContent neutralizes HTML in agent output", (t) => {
  if (!requireSetup(t)) return;
  const { html } = emailDelivery.buildRunEmailContent({
    agentName: 'Agent <script>alert("x")</script>',
    agentType: "research",
    run: { summary: null, startedAt: new Date("2026-07-20T13:00:00Z") },
    output: 'Hello <script>alert("boom")</script> [bad](javascript:alert(1)) world.',
  });
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /Hello/);
  assert.match(html, /world\./);
});

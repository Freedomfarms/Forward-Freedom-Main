import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import {
  AGENT_REQUEST_KINDS,
  buildExecutionEvidence,
  classifyAgentRequest,
  guardAgentReply,
  isMutatingActionAllowed,
  renderRequestClassificationSection,
  renderSubAgentAuthoritySection,
  validateExecutionClaims,
} from "../server/agents/executionContract.js";
import { isEmailReportRequest } from "../server/agents/emailDelivery.js";

// ── Classification: intent ≠ execution ───────────────────────────────────────

test("status question: Did you email this? is not an action request", () => {
  const kind = classifyAgentRequest(
    "Did you email this run or did you just run it?"
  );
  assert.equal(kind, AGENT_REQUEST_KINDS.STATUS_QUESTION);
  assert.equal(isMutatingActionAllowed(kind, "email_report"), false);
  assert.equal(isEmailReportRequest("Did you email this run or did you just run it?"), false);
});

test("1. user asks if something happened → no action created (email short-circuit blocked)", () => {
  assert.equal(
    isEmailReportRequest("Did you email this run or did you just run it?"),
    false
  );
  assert.equal(
    isMutatingActionAllowed(
      classifyAgentRequest("Did you email this run or did you just run it?"),
      "email_report"
    ),
    false
  );
});

test("action request: Email me the report is allowed to mutate", () => {
  const kind = classifyAgentRequest("Email me the report");
  assert.equal(kind, AGENT_REQUEST_KINDS.ACTION_REQUEST);
  assert.equal(isMutatingActionAllowed(kind, "email_report"), true);
  assert.equal(isEmailReportRequest("Email me the report"), true);
});

test("information request does not create actions", () => {
  const kind = classifyAgentRequest("What did the last run find?");
  assert.equal(kind, AGENT_REQUEST_KINDS.INFORMATION_REQUEST);
  assert.equal(isMutatingActionAllowed(kind, "run_now"), false);
});

// ── Guard: unsupported completion claims ─────────────────────────────────────

test("2. user asks status of email → hallucinated Done email is rewritten", () => {
  const evidence = buildExecutionEvidence({
    actionResult: null,
    taskActionType: null,
    relatedRun: { id: "run-1", status: "SUCCEEDED", summary: "Fed brief ready" },
    recentRuns: [{ summary: "Fed brief ready" }],
  });
  const guarded = guardAgentReply({
    reply: "Done — I've emailed that report to your verified account address.",
    userMessage: "Did you email this run or did you just run it?",
    evidence,
    requestKind: AGENT_REQUEST_KINDS.STATUS_QUESTION,
  });
  assert.equal(guarded.rewritten, true);
  assert.match(guarded.reply, /do not have evidence that an email was sent/i);
  assert.doesNotMatch(guarded.reply, /I've emailed/i);
});

test("status response allowed when historical run summary shows email sent", () => {
  const evidence = buildExecutionEvidence({
    relatedRun: {
      id: "run-2",
      status: "SUCCEEDED",
      summary: "Fed brief ready (email sent to your verified account address)",
    },
    recentRuns: [
      {
        summary: "Fed brief ready (email sent to your verified account address)",
      },
    ],
  });
  const guarded = guardAgentReply({
    reply: "Yes — that run was emailed to your verified account address.",
    userMessage: "Was the last report emailed?",
    evidence,
    requestKind: AGENT_REQUEST_KINDS.STATUS_QUESTION,
  });
  assert.equal(guarded.ok, true);
  assert.match(guarded.reply, /emailed/i);
});

test("3. tool succeeds → completion claim allowed", () => {
  const evidence = buildExecutionEvidence({
    actionResult: {
      sent: true,
      emailStatus: "email sent to your verified account address",
      reply: "Done — I've emailed that report to your verified account address.",
      run: { id: "run-3", status: "SUCCEEDED", summary: "ok" },
    },
    taskActionType: "email_report",
  });
  assert.equal(evidence.canClaimEmailed, true);
  const check = validateExecutionClaims(
    "Done — I've emailed that report to your verified account address.",
    evidence,
    { requestKind: AGENT_REQUEST_KINDS.ACTION_REQUEST }
  );
  assert.equal(check.ok, true);

  const guarded = guardAgentReply({
    reply: "Done — I've emailed that report to your verified account address.",
    userMessage: "Email me the report",
    evidence,
    requestKind: AGENT_REQUEST_KINDS.ACTION_REQUEST,
  });
  assert.equal(guarded.rewritten, false);
  assert.match(guarded.reply, /I've emailed/i);
});

test("4. tool fails → failure state communicated", () => {
  const evidence = buildExecutionEvidence({
    actionResult: {
      sent: false,
      emailStatus: "email skipped (email service is not configured)",
      reply:
        "I couldn't email it: email skipped (email service is not configured). The full report is still available here in Freedom OS.",
      run: { id: "run-4", status: "SUCCEEDED", summary: "ok" },
    },
    taskActionType: "email_report",
  });
  assert.equal(evidence.canClaimEmailed, false);
  assert.equal(evidence.thisTurn.emailFailed, true);

  const guarded = guardAgentReply({
    reply: "Done — I've emailed that report to your verified account address.",
    userMessage: "Email me the report",
    evidence,
    requestKind: AGENT_REQUEST_KINDS.ACTION_REQUEST,
  });
  assert.equal(guarded.rewritten, true);
  assert.match(
    guarded.reply,
    /do not have evidence of a successful email|do not have evidence that an email was sent/i
  );
});

test("run_now failure blocks success+email claims", () => {
  const evidence = buildExecutionEvidence({
    actionResult: {
      reply: "I ran, but the run failed: model timeout.",
      run: { id: "run-5", status: "FAILED", summary: null, error: "model timeout" },
    },
    taskActionType: "run_now",
  });
  assert.equal(evidence.thisTurn.runFailed, true);
  assert.equal(evidence.thisTurn.runSucceeded, false);

  const grounded = guardAgentReply({
    reply: "Done — everything completed successfully and I emailed you.",
    userMessage: "Run yourself now",
    evidence,
    requestKind: AGENT_REQUEST_KINDS.ACTION_REQUEST,
  });
  assert.equal(grounded.rewritten, true);
  assert.match(grounded.reply, /failed|do not have evidence/i);
});

// ── Shared authority + Plan context surface ──────────────────────────────────

test("sub-agent authority section forbids Plans and unsupported claims", () => {
  const section = renderSubAgentAuthoritySection();
  assert.match(section, /can_create_plans: no/);
  assert.match(section, /can_claim_outcomes_without_proof: no/);
  assert.match(section, /ceo_is_authority: true/);
});

test("request classification section marks status questions", () => {
  const section = renderRequestClassificationSection(AGENT_REQUEST_KINDS.STATUS_QUESTION);
  assert.match(section, /kind: status_question/);
  assert.match(section, /Do not perform new actions/i);
});

// Integration: Plan load for sub-agent dual context (fake DB)
let setupError = null;
let createFakeDb;
let currentDb;
let createPlan;
let loadPrimaryActivePlan;
let toActiveMissionFromPlan;
let renderPlanMission;

before(async () => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  process.env.FREEDOM_OS_DEBUG_CEO = "0";
  try {
    const { resetKeyProviderCache } = await import("../server/security/keyProvider.js");
    resetKeyProviderCache();
    mock.module("../server/db/prisma.js", {
      namedExports: {
        withUserContext: async (_userId, fn) => fn(currentDb.tx),
        getPrismaClient: () => null,
        isDatabaseConfigured: () => false,
        Prisma: {},
      },
    });
    ({ createFakeDb } = await import("./helpers/fakeAgentDb.js"));
    ({
      createPlan,
      loadPrimaryActivePlan,
      toActiveMissionFromPlan,
      renderPlanMission,
    } = await import("../server/brain/plans.js"));
  } catch (error) {
    setupError = error;
  }
});

beforeEach(() => {
  if (!createFakeDb) return;
  currentDb = createFakeDb({
    user: [{ id: "user-exec-1", email: "exec@example.com", displayName: "Pat" }],
  });
});

test("5. CEO Plan render is injectable for sub-agent context", async (t) => {
  if (setupError) {
    t.skip(`requires --experimental-test-module-mocks (${setupError.message})`);
    return;
  }
  const mission = {
    authority: "plan",
    planId: "plan-1",
    status: "ACTIVE",
    missionScope: "default",
    mission: "Monitor Federal Reserve announcements weekly",
    confidence: "high",
    known: ["Research agent owns Fed brief"],
    plannedActions: [{ text: "Publish weekly brief", owner: "agent" }],
  };
  const rendered = renderPlanMission(mission);
  assert.match(rendered, /Monitor Federal Reserve/);
  assert.match(rendered, /authority: plan/);
  assert.match(rendered, /not a workflow/);
});

test("6. sub-agent receives CEO Plan context correctly (load + render)", async (t) => {
  if (setupError) {
    t.skip(`requires --experimental-test-module-mocks (${setupError.message})`);
    return;
  }
  const created = await createPlan({
    userId: "user-exec-1",
    objective: "Monitor Federal Reserve announcements weekly",
    reason: "durable research mission",
  });
  assert.equal(created.created, true);

  const loaded = await loadPrimaryActivePlan("user-exec-1");
  assert.ok(loaded);
  const mission = toActiveMissionFromPlan(loaded.row, loaded.body);
  const section = [
    renderPlanMission(mission),
    "note: You may reason against this intent and return evidence. You cannot create or update Plans.",
  ].join("\n");
  assert.match(section, /CEO|authority: plan|Monitor Federal Reserve/i);
  assert.match(section, /cannot create or update Plans/i);
  assert.equal(mission.authority, "plan");
});

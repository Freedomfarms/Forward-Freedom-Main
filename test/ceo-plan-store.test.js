import test, { before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// Phase 2B Plan Store — requires: node --test --experimental-test-module-mocks

let setupError = null;
let createFakeDb;
let currentDb;
let createPlan;
let updatePlan;
let getPlan;
let loadPrimaryActivePlan;
let emptyPlanBody;
let validateAndApplyOps;
let toActiveMissionFromPlan;
let renderPlanMission;
let ALLOWED_PLAN_OPS;
let BLOCKED_PLAN_OPS;
let renderIdentitySituationBrief;
let renderInferredMission;
let buildIdentityNamespaces;
let encryptJson;

const USER_ID = "user-plan-1";

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
    ({ encryptJson } = await import("../server/security/envelope.js"));
    ({
      createPlan,
      updatePlan,
      getPlan,
      loadPrimaryActivePlan,
      emptyPlanBody,
      validateAndApplyOps,
      toActiveMissionFromPlan,
      renderPlanMission,
      ALLOWED_PLAN_OPS,
      BLOCKED_PLAN_OPS,
    } = await import("../server/brain/plans.js"));
    ({
      renderIdentitySituationBrief,
      renderInferredMission,
      buildIdentityNamespaces,
    } = await import("../server/brain/identity.js"));
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

beforeEach(() => {
  if (!createFakeDb) return;
  currentDb = createFakeDb({
    user: [{ id: USER_ID, email: "plan@example.com", displayName: "Pat" }],
  });
});

test("1. CEO can create a Plan from durable intent", async (t) => {
  if (!requireSetup(t)) return;

  const result = await createPlan({
    userId: USER_ID,
    objective: "Buy a lake cabin within five years without taking on more debt",
    confidence: "high",
    reason: "user stated multi-year durable goal",
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.plan.status, "ACTIVE");
  assert.match(result.plan.objective.text, /lake cabin/i);
  assert.equal(result.plan.grantsExecutionAuthority, false);
  assert.equal(result.plan.isWorkflow, false);

  const loaded = await loadPrimaryActivePlan(USER_ID);
  assert.ok(loaded);
  assert.match(loaded.body.objective.text, /lake cabin/i);
  assert.ok(loaded.body.changeLog.length >= 1);
});

test("2. CEO can update a Plan without creating duplicate Plans", async (t) => {
  if (!requireSetup(t)) return;

  const created = await createPlan({
    userId: USER_ID,
    objective: "Build a weekly vendor analysis report for farm suppliers",
    reason: "durable reporting intent",
  });
  assert.equal(created.created, true);

  const dup = await createPlan({
    userId: USER_ID,
    objective: "Build a weekly vendor analysis report for farm suppliers",
    reason: "same conversation restated",
  });
  assert.equal(dup.ok, true);
  assert.equal(dup.created, false);
  assert.equal(dup.deduped, true);
  assert.equal(dup.plan.id, created.plan.id);

  // Same mission scope + near-duplicate objective → reuse existing (no second ACTIVE).
  const similarSameScope = await createPlan({
    userId: USER_ID,
    objective: "Build weekly vendor analysis reports for our farm suppliers",
    reason: "near duplicate phrasing",
  });
  assert.equal(similarSameScope.ok, true);
  assert.equal(similarSameScope.created, false);
  assert.equal(similarSameScope.deduped, true);
  assert.equal(similarSameScope.plan.id, created.plan.id);

  // Similar objective in a different scope without independent=true → reject.
  const similarOtherScope = await createPlan({
    userId: USER_ID,
    objective: "Build a weekly vendor analysis report for farm suppliers",
    missionScope: "ops-reporting-b",
    independent: false,
    reason: "should not fork a similar mission without independent flag",
  });
  assert.equal(similarOtherScope.ok, false);
  assert.equal(similarOtherScope.code, "PLAN_DUPLICATE");

  const updated = await updatePlan({
    userId: USER_ID,
    planId: created.plan.id,
    reason: "captured budget constraint from user",
    ops: [
      { op: "add_constraint", text: "Stay under $200/month tooling cost" },
      { op: "add_action", text: "Draft vendor scorecard template", owner: "ceo" },
    ],
  });
  assert.equal(updated.ok, true);
  assert.ok(updated.fieldsChanged.length >= 2);

  const activeCount = await currentDb.tx.plan.count({
    where: { userId: USER_ID, status: "ACTIVE" },
  });
  assert.equal(activeCount, 1);
});

test("3. Plan cannot grant execution authority", async (t) => {
  if (!requireSetup(t)) return;

  for (const op of BLOCKED_PLAN_OPS) {
    const body = emptyPlanBody({ objective: "Ship monthly cash summary" });
    const result = validateAndApplyOps(body, [{ op }], { reason: "probe blocked op" });
    assert.equal(result.ok, false, op);
    assert.ok(
      result.errors.some((e) => /Blocked Plan op|Unknown Plan op|No meaningful/i.test(e)),
      op
    );
  }

  const body = emptyPlanBody({ objective: "Ship monthly cash summary" });
  const poisoned = {
    ...body,
    permissions: { canTrade: true },
  };
  const result = validateAndApplyOps(poisoned, [{ op: "note", summary: "x" }], {
    reason: "should fail forbidden field",
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /must not contain/i.test(e)));

  assert.ok(ALLOWED_PLAN_OPS.includes("record_preference"));
  assert.ok(!ALLOWED_PLAN_OPS.includes("set_permissions"));
});

test("4. Completed actions require execution evidence", async (t) => {
  if (!requireSetup(t)) return;

  const body = emptyPlanBody({ objective: "Create vendor analysis report" });
  const planned = validateAndApplyOps(
    body,
    [{ op: "add_action", text: "Generate vendor analysis report", owner: "agent" }],
    { reason: "plan the work" }
  );
  assert.equal(planned.ok, true);
  const actionId = planned.body.actions[0].id;

  const noEvidence = validateAndApplyOps(
    planned.body,
    [{ op: "complete_action", id: actionId }],
    { reason: "CEO wants to mark done" }
  );
  assert.equal(noEvidence.ok, false);
  assert.ok(noEvidence.errors.some((e) => /execution evidence/i.test(e)));

  const withEvidence = validateAndApplyOps(
    planned.body,
    [
      {
        op: "complete_action",
        id: actionId,
        evidence: {
          kind: "tool_result",
          summary: "Report generation tool completed successfully",
          ref: "run_abc",
        },
      },
    ],
    { reason: "tool result confirmed completion" }
  );
  assert.equal(withEvidence.ok, true);
  assert.equal(withEvidence.body.actions[0].status, "completed");
  assert.equal(withEvidence.body.actions[0].evidence.kind, "tool_result");
});

test("5. Existing CEO behavior works when no Plan exists", async (t) => {
  if (!requireSetup(t)) return;

  const primary = await loadPrimaryActivePlan(USER_ID);
  assert.equal(primary, null);

  const inferred = renderInferredMission({
    mission: "Quick question about connected banks",
    known: ["Plaid linked"],
    missing: ["which account"],
    selectedQuestion: "Which account?",
  });
  assert.match(inferred, /authority: inferred_from_conversation/);
  assert.match(inferred, /possible_objective:/);
  assert.doesNotMatch(inferred, /Ask .* next/i);
  assert.doesNotMatch(inferred, /Which account/);

  const identities = buildIdentityNamespaces({
    ceoConfig: { name: "CEO Agent" },
    user: { displayName: "Pat" },
    teamAgents: [],
    profile: null,
  });
  const brief = renderIdentitySituationBrief({
    identities,
    activeMission: {
      mission: "Quick question about connected banks",
      authority: "inferred_metadata_only",
      known: ["Plaid linked"],
    },
  }).join("\n");
  assert.match(brief, /ACTIVE MISSION \(inferred, not authoritative\)/);
  assert.doesNotMatch(brief, /from Plan/);
});

test("6. ACTIVE MISSION prefers Plan over inferred mission when available", async (t) => {
  if (!requireSetup(t)) return;

  const created = await createPlan({
    userId: USER_ID,
    objective: "Reduce operating costs by 10% this year",
    confidence: "medium",
    reason: "annual cost mission",
  });
  const decoded = await loadPrimaryActivePlan(USER_ID);
  const fromPlan = toActiveMissionFromPlan(decoded.row, decoded.body);
  assert.equal(fromPlan.authority, "plan");
  assert.equal(fromPlan.planId, created.plan.id);

  const identities = buildIdentityNamespaces({
    ceoConfig: { name: "CEO Agent" },
    user: { displayName: "Pat" },
    teamAgents: [],
    profile: null,
  });
  const brief = renderIdentitySituationBrief({
    identities,
    activeMission: fromPlan,
  }).join("\n");
  assert.match(brief, /ACTIVE MISSION \(from Plan\)/);
  assert.match(brief, /authority: plan/);
  assert.match(brief, /Reduce operating costs/);
  assert.doesNotMatch(brief, /inferred, not authoritative/);
  assert.doesNotMatch(brief, /possible_objective:/);

  const rendered = renderPlanMission(fromPlan);
  assert.match(rendered, /durable_executive_memory/);
  assert.match(rendered, /not a workflow/);
  assert.ok(typeof encryptJson === "function");
});

test("update_plan rejects missing reason and no-op thrash", async (t) => {
  if (!requireSetup(t)) return;

  await createPlan({
    userId: USER_ID,
    objective: "Prepare for equipment refinance decision",
    reason: "durable financing intent",
  });

  const noReason = await updatePlan({
    userId: USER_ID,
    ops: [{ op: "add_known", text: "Bank asked for tax returns" }],
    reason: "",
  });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.code, "PLAN_REASON_REQUIRED");

  const first = await updatePlan({
    userId: USER_ID,
    reason: "user provided bank ask",
    ops: [{ op: "add_known", text: "Bank asked for tax returns" }],
  });
  assert.equal(first.ok, true);

  const thrash = await updatePlan({
    userId: USER_ID,
    reason: "repeat same fact",
    ops: [{ op: "add_known", text: "Bank asked for tax returns" }],
  });
  assert.equal(thrash.ok, false);
  assert.match(thrash.error, /No meaningful Plan changes/i);
});

test("get_plan returns public view without execution authority", async (t) => {
  if (!requireSetup(t)) return;

  await createPlan({
    userId: USER_ID,
    objective: "Stand up a reminders agent for irrigation checks",
    reason: "durable ops intent",
  });
  const got = await getPlan({ userId: USER_ID });
  assert.equal(got.ok, true);
  assert.equal(got.plan.grantsExecutionAuthority, false);
  assert.equal(got.plan.grantsToolPermissions, false);
  assert.ok(got.plan.changeLog.length >= 1);
});

// CHIEF approval semantics tests — translated from the #[cfg(test)] suite in
// möbius src/backend/sandbox/approval.rs (commit 3e1aaf5), plus the sticky
// session-approval cap behavior that suite exercises indirectly.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ApprovalPolicy,
  ApprovalCoordinator,
  DEFAULT_APPROVAL_POLICY,
  MAX_SESSION_APPROVALS,
  NetworkAccess,
  SandboxMode,
  callKey,
  parseApprovalPolicy,
  policyNetworkAccess,
  policySandboxMode,
} from "../server/chief/runtime/approvals.js";
import {
  ReviewDecisionType,
  parseReviewDecision,
  encodeReviewDecision,
} from "../server/chief/protocol/index.js";

// Upstream: manifest_policy_values_parse_in_core
test("policy wire values parse and unknown values are rejected", () => {
  for (const [value, expected] of [
    ["ask", ApprovalPolicy.ASK],
    ["allow", ApprovalPolicy.ALLOW],
    ["allow_network", ApprovalPolicy.ALLOW_NETWORK],
    ["full_access", ApprovalPolicy.FULL_ACCESS],
  ]) {
    assert.equal(parseApprovalPolicy(value), expected);
    assert.equal(new ApprovalCoordinator(value).policy, expected);
  }
  assert.equal(DEFAULT_APPROVAL_POLICY, ApprovalPolicy.ASK);
  assert.throws(() => parseApprovalPolicy("auto_approve"), /unknown sandbox approval policy/);
});

// Upstream: authorized_execution_modes_assign_backend_network_access
test("network access and sandbox mode per policy", () => {
  assert.equal(policyNetworkAccess(ApprovalPolicy.ASK), NetworkAccess.ALLOWED);
  assert.equal(policyNetworkAccess(ApprovalPolicy.ALLOW), NetworkAccess.DENIED);
  assert.equal(policyNetworkAccess(ApprovalPolicy.ALLOW_NETWORK), NetworkAccess.ALLOWED);
  assert.equal(policyNetworkAccess(ApprovalPolicy.FULL_ACCESS), NetworkAccess.ALLOWED);
  assert.equal(policySandboxMode(ApprovalPolicy.FULL_ACCESS), SandboxMode.DANGER_FULL_ACCESS);
  assert.equal(policySandboxMode(ApprovalPolicy.ASK), SandboxMode.WORKSPACE_WRITE);
});

// Upstream: full_access_authorizes_mutations_without_review
test("full_access authorizes mutations without review", () => {
  const approval = new ApprovalCoordinator(ApprovalPolicy.FULL_ACCESS);
  approval.sessionStart("session");
  const calls = [
    { callId: "write", name: "write_file", arguments: { path: "a" } },
  ];
  const authorization = approval.authorize("session", calls, ["write"]);
  assert.equal(authorization.type, "execute");
  const permissions = authorization.permissions.forCall("write");
  assert.equal(permissions.sandboxMode, SandboxMode.DANGER_FULL_ACCESS);
  assert.equal(permissions.networkAccess, NetworkAccess.ALLOWED);
  assert.equal(permissions.mutation, true);
});

// Upstream: approval_grants_only_the_reviewed_call
test("ask policy requests approval and resolve grants only the reviewed call", () => {
  const approval = new ApprovalCoordinator(ApprovalPolicy.ASK);
  approval.sessionStart("session");
  const calls = [
    { callId: "write", name: "write_file", arguments: { path: "a" } },
  ];

  const authorization = approval.authorize("session", calls, ["write"]);
  assert.equal(authorization.type, "approval");
  assert.equal(authorization.request.reason, "one or more tools require approval");
  assert.deepEqual(authorization.request.callIds, ["write"]);
  assert.equal(authorization.permissions.networkAccess, NetworkAccess.ALLOWED);
  assert.equal(authorization.permissions.forCall("write").mutation, false);

  const permissions = approval.resolve(
    "session",
    calls,
    authorization.request.callIds,
    { type: ReviewDecisionType.APPROVED },
    authorization.permissions,
  );
  assert.equal(permissions.forCall("write").mutation, true);
});

test("denied and abort decisions grant nothing", () => {
  const approval = new ApprovalCoordinator(ApprovalPolicy.ASK);
  approval.sessionStart("session");
  const calls = [{ callId: "write", name: "write_file", arguments: { path: "a" } }];
  for (const decision of [
    { type: ReviewDecisionType.DENIED, rejection: "not allowed" },
    { type: ReviewDecisionType.ABORT },
  ]) {
    const authorization = approval.authorize("session", calls, ["write"]);
    const permissions = approval.resolve(
      "session",
      calls,
      authorization.request.callIds,
      decision,
      authorization.permissions,
    );
    assert.equal(permissions.forCall("write").mutation, false);
  }
});

test("approved_for_session sticks: the same call executes without review next time", () => {
  const approval = new ApprovalCoordinator(ApprovalPolicy.ASK);
  approval.sessionStart("session");
  const calls = [{ callId: "write", name: "write_file", arguments: { path: "a" } }];

  const first = approval.authorize("session", calls, ["write"]);
  assert.equal(first.type, "approval");
  approval.resolve(
    "session",
    calls,
    first.request.callIds,
    { type: ReviewDecisionType.APPROVED_FOR_SESSION },
    first.permissions,
  );

  // Same session + tool + arguments → sticky approval applies.
  const second = approval.authorize("session", calls, ["write"]);
  assert.equal(second.type, "execute");
  assert.equal(second.permissions.forCall("write").mutation, true);

  // Different arguments → a new approval is required.
  const otherCalls = [{ callId: "write2", name: "write_file", arguments: { path: "b" } }];
  const third = approval.authorize("session", otherCalls, ["write2"]);
  assert.equal(third.type, "approval");

  // A different session never inherits sticky approvals.
  approval.sessionStart("other-session");
  const fourth = approval.authorize("other-session", calls, ["write"]);
  assert.equal(fourth.type, "approval");
});

test("sticky approvals are capped: the set clears at MAX_SESSION_APPROVALS", () => {
  const approval = new ApprovalCoordinator(ApprovalPolicy.ASK);
  approval.sessionStart("session");
  const callFor = (i) => [{ callId: `c${i}`, name: "tool", arguments: { i } }];
  for (let i = 0; i < MAX_SESSION_APPROVALS; i += 1) {
    const calls = callFor(i);
    const authorization = approval.authorize("session", calls, [`c${i}`]);
    approval.resolve(
      "session",
      calls,
      authorization.request.callIds,
      { type: ReviewDecisionType.APPROVED_FOR_SESSION },
      authorization.permissions,
    );
  }
  // The 65th sticky approval clears the set first (upstream behavior), so the
  // very first approved call requires review again afterwards.
  const overflowCalls = callFor(MAX_SESSION_APPROVALS);
  const overflowAuth = approval.authorize("session", overflowCalls, [
    `c${MAX_SESSION_APPROVALS}`,
  ]);
  approval.resolve(
    "session",
    overflowCalls,
    overflowAuth.request.callIds,
    { type: ReviewDecisionType.APPROVED_FOR_SESSION },
    overflowAuth.permissions,
  );
  const replay = approval.authorize("session", callFor(0), ["c0"]);
  assert.equal(replay.type, "approval");
});

test("unknown mutation or approval call ids are errors", () => {
  const approval = new ApprovalCoordinator(ApprovalPolicy.ASK);
  approval.sessionStart("session");
  const calls = [{ callId: "known", name: "tool", arguments: {} }];
  assert.throws(
    () => approval.authorize("session", calls, ["missing"]),
    /unknown mutation call `missing`/,
  );
  const authorization = approval.authorize("session", calls, ["known"]);
  assert.throws(
    () =>
      approval.resolve(
        "session",
        calls,
        ["missing"],
        { type: ReviewDecisionType.APPROVED },
        authorization.permissions,
      ),
    /approval references unknown call `missing`/,
  );
});

test("authorizing an uninitialized or ended session is an error", () => {
  const approval = new ApprovalCoordinator(ApprovalPolicy.ASK);
  assert.throws(
    () => approval.authorize("nope", [], []),
    /approval state is not initialized/,
  );
  approval.sessionStart("session");
  approval.sessionEnd("session");
  assert.throws(
    () => approval.authorize("session", [], []),
    /approval state is not initialized/,
  );
});

test("callKey is SHA-256 over the JSON tuple (session, name, arguments)", () => {
  const call = { callId: "c", name: "write_file", arguments: { path: "a" } };
  const expected = createHash("sha256")
    .update(JSON.stringify(["session", "write_file", { path: "a" }]))
    .digest("hex");
  assert.equal(callKey("session", call), expected);
  assert.notEqual(callKey("other", call), expected);
});

test("ReviewDecision wire shape matches upstream serde encoding", () => {
  assert.deepEqual(parseReviewDecision("approved"), {
    type: ReviewDecisionType.APPROVED,
  });
  assert.deepEqual(parseReviewDecision("approved_for_session"), {
    type: ReviewDecisionType.APPROVED_FOR_SESSION,
  });
  assert.deepEqual(parseReviewDecision("abort"), { type: ReviewDecisionType.ABORT });
  assert.deepEqual(parseReviewDecision({ denied: { rejection: "too risky" } }), {
    type: ReviewDecisionType.DENIED,
    rejection: "too risky",
  });
  assert.throws(() => parseReviewDecision("maybe"), /unknown review decision/);
  assert.throws(() => parseReviewDecision({ denied: {} }), /unknown review decision/);

  assert.equal(encodeReviewDecision({ type: ReviewDecisionType.APPROVED }), "approved");
  assert.deepEqual(
    encodeReviewDecision({ type: ReviewDecisionType.DENIED, rejection: "no" }),
    { denied: { rejection: "no" } },
  );
});

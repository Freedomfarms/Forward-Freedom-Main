// CHIEF protocol tests — translated from the wire-shape tests in möbius
// src/protocol/mod.rs and events.rs (commit 3e1aaf5): submissions and events
// keep stable snake_case wire names, system events omit correlation, token
// usage addition is all-or-nothing on overflow.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EventMsgType,
  MAX_MESSAGE_BYTES,
  MessageDelivery,
  ModelStepContentPhase,
  OpType,
  emptyTokenUsage,
  encodeSseEvent,
  eventMsg,
  isEventMsgType,
  makeEvent,
  parseSubmission,
  tokenUsageCheckedAdd,
} from "../server/chief/protocol/index.js";

// Upstream: interrupt_has_a_targeted_wire_shape
test("interrupt op has a targeted wire shape", () => {
  const submission = parseSubmission({
    id: "cancel-1",
    op: { type: "interrupt", turn_id: "turn-1" },
  });
  assert.deepEqual(submission, {
    id: "cancel-1",
    op: { type: "interrupt", turn_id: "turn-1" },
  });
});

test("unknown op types and malformed submissions are rejected", () => {
  assert.throws(() => parseSubmission({ id: "x", op: { type: "self_destruct" } }), /unknown op type/);
  assert.throws(() => parseSubmission({ op: { type: "interrupt", turn_id: "t" } }), /submission id/);
  assert.throws(() => parseSubmission({ id: "x", op: null }), /tagged object/);
  assert.throws(() => parseSubmission({ id: "x", op: { type: "interrupt" } }), /turn_id/);
  assert.throws(
    () => parseSubmission({ id: "x", op: { type: "exec_approval", id: "a", decision: "maybe" } }),
    /unknown review decision/,
  );
});

test("message op enforces the 1 MiB size limit", () => {
  const ok = parseSubmission({
    id: "input-1",
    op: { type: "message", message: { text: "hello" } },
  });
  assert.equal(ok.op.message.text, "hello");
  assert.throws(
    () =>
      parseSubmission({
        id: "input-2",
        op: { type: "message", message: { text: "x".repeat(MAX_MESSAGE_BYTES + 1) } },
      }),
    /exceeds size limit/,
  );
});

// Upstream: system_event_omits_submission_correlation
test("system events omit submission correlation; command events carry it", () => {
  const system = makeEvent(eventMsg.warning("system notice"));
  assert.deepEqual(system, {
    msg: { type: "warning", message: "system notice" },
  });
  assert.equal("submission_id" in system, false);

  const correlated = makeEvent(eventMsg.turnComplete("turn-1"), "submit-1");
  assert.deepEqual(correlated, {
    submission_id: "submit-1",
    msg: { type: "turn_complete", turn_id: "turn-1" },
  });
});

// Upstream: conversation_events_use_turn_and_text_wire_names
test("turn lifecycle events use upstream wire names", () => {
  assert.deepEqual(eventMsg.turnStarted("turn-1", 128000), {
    type: "turn_started",
    turn_id: "turn-1",
    model_context_window: 128000,
  });
  assert.deepEqual(eventMsg.turnComplete("turn-1"), {
    type: "turn_complete",
    turn_id: "turn-1",
  });
  assert.deepEqual(eventMsg.turnAborted("turn-1", "interrupted"), {
    type: "turn_aborted",
    turn_id: "turn-1",
    reason: "interrupted",
  });
});

// Upstream: model_events_keep_typed_correlation_and_web_search_fields (delta shape)
test("assistant content deltas keep typed correlation fields and phases", () => {
  assert.deepEqual(
    eventMsg.assistantContentDelta({
      sessionId: "session-1",
      turnId: "turn-1",
      modelStepId: "step-1",
      delta: "Checking",
      phase: ModelStepContentPhase.COMMENTARY,
    }),
    {
      type: "assistant_content_delta",
      session_id: "session-1",
      turn_id: "turn-1",
      model_step_id: "step-1",
      delta: "Checking",
      phase: "commentary",
    },
  );
  assert.deepEqual(Object.values(ModelStepContentPhase), [
    "reasoning",
    "commentary",
    "final_answer",
  ]);
});

test("exec approval request event carries the paused calls", () => {
  const msg = eventMsg.execApprovalRequest({
    id: "approval",
    turnId: "turn",
    calls: [{ callId: "call", name: "bash", arguments: { command: "true" } }],
    reason: "command execution",
  });
  assert.deepEqual(msg, {
    type: "exec_approval_request",
    id: "approval",
    turn_id: "turn",
    calls: [{ call_id: "call", name: "bash", arguments: { command: "true" } }],
    reason: "command execution",
  });
});

// Upstream: context_compacted_is_a_unit_event
test("context_compacted is a unit event", () => {
  assert.deepEqual(eventMsg.contextCompacted(), { type: "context_compacted" });
});

// Upstream: submission_rejection_has_a_typed_wire_shape
test("submission rejection has a typed wire shape", () => {
  assert.deepEqual(eventMsg.submissionRejected("message queue is full"), {
    type: "submission_rejected",
    message: "message queue is full",
  });
});

// Upstream: token_usage_overflow_does_not_partially_update_the_total
test("token usage overflow does not partially update the total", () => {
  const total = {
    ...emptyTokenUsage(),
    input_tokens: 7,
    total_tokens: Number.MAX_SAFE_INTEGER,
  };
  const original = { ...total };
  const result = tokenUsageCheckedAdd(total, {
    ...emptyTokenUsage(),
    input_tokens: 1,
    total_tokens: 1,
  });
  assert.equal(result, null);
  assert.deepEqual(total, original);

  const ok = tokenUsageCheckedAdd(
    { ...emptyTokenUsage(), input_tokens: 1, total_tokens: 1 },
    { ...emptyTokenUsage(), input_tokens: 2, total_tokens: 2 },
  );
  assert.equal(ok.input_tokens, 3);
  assert.equal(ok.total_tokens, 3);
});

test("EventMsg taxonomy covers the upstream wire tags", () => {
  for (const tag of [
    "message_delta",
    "error",
    "warning",
    "submission_rejected",
    "session_configured",
    "turn_started",
    "turn_complete",
    "turn_aborted",
    "message",
    "assistant_message",
    "assistant_content_delta",
    "model_step_started",
    "model_step_completed",
    "session_history",
    "model_changed",
    "session_resume_requested",
    "tool_call_begin",
    "tool_call_end",
    "tool_load",
    "exec_approval_request",
    "token_count",
    "context_compacted",
    "web_search_begin",
    "web_search_end",
    "frontend",
  ]) {
    assert.equal(isEventMsgType(tag), true, `missing EventMsg tag ${tag}`);
  }
  assert.equal(isEventMsgType("internal_secret_event"), false);
  assert.deepEqual(Object.values(MessageDelivery), ["turn", "steer", "queue"]);
  assert.deepEqual(new Set(Object.values(OpType)), new Set([
    "message",
    "interrupt",
    "exec_approval",
    "capability_command",
    "set_model",
    "resume_session",
  ]));
});

test("SSE encoding frames one event envelope per message", () => {
  const event = makeEvent(eventMsg.turnComplete("turn-1"), "submit-1");
  assert.equal(
    encodeSseEvent(event),
    `data: ${JSON.stringify(event)}\n\n`,
  );
  assert.equal(
    encodeSseEvent(event, { id: 7 }),
    `id: 7\ndata: ${JSON.stringify(event)}\n\n`,
  );
  assert.equal(EventMsgType.TURN_COMPLETE, "turn_complete");
});

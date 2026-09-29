// CHIEF frontend protocol — the small Op/EventMsg event protocol shared by
// CHIEF frontends (Command Center), plus SSE encoding for the event stream.
//
// PORT/ADAPT of möbius (citizenhicks, Apache-2.0; NOTICE reproduced in
// THIRD_PARTY_NOTICES.md — derived in part from OpenAI Codex and Ratatui)
//   Upstream: https://github.com/citizenhicks/mobius
//   Source files: src/protocol/mod.rs, src/protocol/events.rs
//   Commit: 3e1aaf5039f5069c3142861cb145fc0fb5521284
//   License text: licenses/MOBIUS-LICENSE-APACHE-2.0.txt (NOTICE: licenses/MOBIUS-NOTICE.txt)
//
// Preserved upstream semantics:
//   - Submission { id, op } envelope: the submission id correlates all events
//     produced by one command
//   - Op taxonomy wire tags (tag field "type", snake_case): message,
//     interrupt, exec_approval, capability_command, set_model, resume_session
//   - Event { submission_id?, msg } envelope: system events omit correlation
//   - EventMsg taxonomy wire tags (tag field "type", snake_case) — the full
//     upstream set, so the Command Center consumes one stable contract
//   - message size limits (1 MiB message, 64 KiB capability input)
//   - TokenUsage field set and overflow-safe checkedAdd (all-or-nothing:
//     overflow must not partially update the total)
//   - presentation separation: frontends receive typed events and never
//     branch on internal capability names (docs/CHIEF_ARCHITECTURE.md §5.3)
// Documented adaptations (CHIEF-specific reasons):
//   - Rust structs become plain-object constructors + validators; unknown Op
//     types are rejected at the API boundary (serde's job upstream).
//   - Events are delivered over SSE instead of möbius's Noise WebSocket
//     (platform already provides authenticated HTTPS) — encodeSseEvent below.
//   - Integer overflow guards use Number.MAX_SAFE_INTEGER instead of i64.

// Maximum total UTF-8 bytes accepted in one user-input submission.
export const MAX_MESSAGE_BYTES = 1024 * 1024;
// Maximum UTF-8 bytes accepted in capability command input or a queued edit.
export const MAX_CAPABILITY_INPUT_BYTES = 64 * 1024;

// Commands supported by the agent (möbius `Op`).
export const OpType = Object.freeze({
  MESSAGE: "message",
  INTERRUPT: "interrupt",
  EXEC_APPROVAL: "exec_approval",
  CAPABILITY_COMMAND: "capability_command",
  SET_MODEL: "set_model",
  RESUME_SESSION: "resume_session",
});

const OP_TYPE_VALUES = new Set(Object.values(OpType));

// Events supported by the minimal frontend contract (möbius `EventMsg`).
export const EventMsgType = Object.freeze({
  MESSAGE_DELTA: "message_delta",
  ERROR: "error",
  WARNING: "warning",
  SUBMISSION_REJECTED: "submission_rejected",
  SESSION_CONFIGURED: "session_configured",
  TURN_STARTED: "turn_started",
  TURN_COMPLETE: "turn_complete",
  TURN_ABORTED: "turn_aborted",
  MESSAGE: "message",
  ASSISTANT_MESSAGE: "assistant_message",
  ASSISTANT_CONTENT_DELTA: "assistant_content_delta",
  MODEL_STEP_STARTED: "model_step_started",
  MODEL_STEP_COMPLETED: "model_step_completed",
  SESSION_HISTORY: "session_history",
  MODEL_CHANGED: "model_changed",
  SESSION_RESUME_REQUESTED: "session_resume_requested",
  TOOL_CALL_BEGIN: "tool_call_begin",
  TOOL_CALL_END: "tool_call_end",
  TOOL_LOAD: "tool_load",
  EXEC_APPROVAL_REQUEST: "exec_approval_request",
  TOKEN_COUNT: "token_count",
  CONTEXT_COMPACTED: "context_compacted",
  WEB_SEARCH_BEGIN: "web_search_begin",
  WEB_SEARCH_END: "web_search_end",
  FRONTEND: "frontend",
});

const EVENT_MSG_TYPE_VALUES = new Set(Object.values(EventMsgType));

export function isEventMsgType(value) {
  return EVENT_MSG_TYPE_VALUES.has(value);
}

// Semantic role of text in a model step (möbius ModelStepContentPhase).
export const ModelStepContentPhase = Object.freeze({
  REASONING: "reasoning",
  COMMENTARY: "commentary",
  FINAL_ANSWER: "final_answer",
});

// How one accepted message actually entered the conversation.
export const MessageDelivery = Object.freeze({
  TURN: "turn",
  STEER: "steer",
  QUEUE: "queue",
});

// A user's decision for a paused tool batch (möbius ReviewDecision,
// src/protocol/events.rs). Wire shape is serde externally tagged: unit
// variants are plain strings ("approved" | "approved_for_session" | "abort");
// the denied variant is { "denied": { "rejection": string } }.
export const ReviewDecisionType = Object.freeze({
  APPROVED: "approved",
  APPROVED_FOR_SESSION: "approved_for_session",
  DENIED: "denied",
  ABORT: "abort",
});

export function parseReviewDecision(value) {
  if (
    value === ReviewDecisionType.APPROVED ||
    value === ReviewDecisionType.APPROVED_FOR_SESSION ||
    value === ReviewDecisionType.ABORT
  ) {
    return { type: value };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.denied === "object" &&
    value.denied !== null &&
    typeof value.denied.rejection === "string"
  ) {
    return { type: ReviewDecisionType.DENIED, rejection: value.denied.rejection };
  }
  throw new Error(`unknown review decision \`${JSON.stringify(value)}\``);
}

export function encodeReviewDecision(decision) {
  if (decision.type === ReviewDecisionType.DENIED) {
    return { denied: { rejection: decision.rejection } };
  }
  return decision.type;
}

function requireString(value, label) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

// Validates one frontend Submission envelope: { id, op: { type, ... } }.
export function parseSubmission(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("submission must be an object");
  }
  requireString(value.id, "submission id");
  const op = value.op;
  if (typeof op !== "object" || op === null || typeof op.type !== "string") {
    throw new Error("submission op must be a tagged object");
  }
  if (!OP_TYPE_VALUES.has(op.type)) {
    throw new Error(`unknown op type \`${op.type}\``);
  }
  switch (op.type) {
    case OpType.MESSAGE: {
      const message = op.message;
      if (typeof message !== "object" || message === null) {
        throw new Error("message op must carry a message");
      }
      if (typeof message.text !== "string") {
        throw new Error("message text must be a string");
      }
      if (Buffer.byteLength(message.text, "utf8") > MAX_MESSAGE_BYTES) {
        throw new Error("message exceeds size limit");
      }
      break;
    }
    case OpType.INTERRUPT:
      requireString(op.turn_id, "interrupt turn_id");
      break;
    case OpType.EXEC_APPROVAL:
      requireString(op.id, "exec_approval id");
      parseReviewDecision(op.decision);
      break;
    case OpType.CAPABILITY_COMMAND: {
      requireString(op.capability, "capability");
      requireString(op.command, "command");
      const input = op.input ?? "";
      if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > MAX_CAPABILITY_INPUT_BYTES) {
        throw new Error("capability input exceeds size limit");
      }
      break;
    }
    case OpType.SET_MODEL:
      requireString(op.route, "model route");
      break;
    case OpType.RESUME_SESSION:
      requireString(op.session_id, "session_id");
      break;
  }
  return { id: value.id, op };
}

// Event envelope: submission-driven events carry the submission id; system
// events omit it (upstream skip_serializing_if on submission_id).
export function makeEvent(msg, submissionId = null) {
  return submissionId === null ? { msg } : { submission_id: submissionId, msg };
}

// Typed EventMsg constructors for the events CHIEF's runtime emits. Field
// names are the upstream wire names.
export const eventMsg = Object.freeze({
  turnStarted: (turnId, modelContextWindow = null) => ({
    type: EventMsgType.TURN_STARTED,
    turn_id: turnId,
    model_context_window: modelContextWindow,
  }),
  turnComplete: (turnId) => ({
    type: EventMsgType.TURN_COMPLETE,
    turn_id: turnId,
  }),
  turnAborted: (turnId, reason) => ({
    type: EventMsgType.TURN_ABORTED,
    turn_id: turnId,
    reason,
  }),
  warning: (message) => ({ type: EventMsgType.WARNING, message }),
  error: ({ kind, message, retryable = false, status = null, retryAfter = null }) => ({
    type: EventMsgType.ERROR,
    kind,
    message,
    retryable,
    status,
    retry_after: retryAfter,
  }),
  submissionRejected: (message) => ({
    type: EventMsgType.SUBMISSION_REJECTED,
    message,
  }),
  assistantContentDelta: ({ sessionId, turnId, modelStepId, delta, phase }) => ({
    type: EventMsgType.ASSISTANT_CONTENT_DELTA,
    session_id: sessionId,
    turn_id: turnId,
    model_step_id: modelStepId,
    delta,
    phase,
  }),
  toolCallBegin: ({ turnId, callId, name, args }) => ({
    type: EventMsgType.TOOL_CALL_BEGIN,
    turn_id: turnId,
    call_id: callId,
    name,
    arguments: args,
  }),
  toolCallEnd: ({ turnId, callId, name, output, isError = false }) => ({
    type: EventMsgType.TOOL_CALL_END,
    turn_id: turnId,
    call_id: callId,
    name,
    output,
    is_error: isError,
  }),
  execApprovalRequest: ({ id, turnId, calls, reason }) => ({
    type: EventMsgType.EXEC_APPROVAL_REQUEST,
    id,
    turn_id: turnId,
    calls: calls.map((call) => ({
      call_id: call.callId ?? call.call_id,
      name: call.name,
      arguments: call.arguments,
    })),
    reason,
  }),
  tokenCount: (info = null, rateLimits = null) => ({
    type: EventMsgType.TOKEN_COUNT,
    info,
    rate_limits: rateLimits,
  }),
  contextCompacted: () => ({ type: EventMsgType.CONTEXT_COMPACTED }),
});

// TokenUsage (möbius src/protocol/events.rs). checkedAdd is all-or-nothing:
// on overflow nothing is mutated and null is returned.
export function emptyTokenUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  };
}

const TOKEN_USAGE_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

export function tokenUsageCheckedAdd(total, other) {
  const next = {};
  for (const field of TOKEN_USAGE_FIELDS) {
    const sum = (total[field] ?? 0) + (other[field] ?? 0);
    if (!Number.isSafeInteger(sum)) {
      return null;
    }
    next[field] = sum;
  }
  Object.assign(total, next);
  return total;
}

// SSE encoding for the event stream (deviation from möbius's WebSocket
// transport, documented in docs/CHIEF_ARCHITECTURE.md §7.2). One Event
// envelope per SSE message; optional id enables Last-Event-ID resume.
export function encodeSseEvent(event, { id = null } = {}) {
  let frame = "";
  if (id !== null) frame += `id: ${id}\n`;
  frame += `data: ${JSON.stringify(event)}\n\n`;
  return frame;
}

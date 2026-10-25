// Pure CHIEF conversation helpers. No network, no Firebase.
//
// The chat route speaks the existing submission envelope:
// `{ session_id?, submission: { id, op } }`.
// A session is created when the first message is posted without session_id,
// or when set_model is posted for a draft so the choice sticks to one session.

const FINANCE_TOOLS = new Set(["finance_summary", "workspace_plan_summary"]);

export const MISSING_CHIEF_ANSWER = "CHIEF did not return an answer.";

export const CHIEF_STATUS = Object.freeze({
  READY: "Ready",
  WORKING: "Working",
  RESPONDING: "Responding",
  TOOL: "CHIEF is using a tool",
  FINANCE: "Checking your financial data",
  WEB_SEARCH: "CHIEF is searching the web...",
  MODULE_ACCESS: "Checking Freedom Financial access",
  MODULE_ACCESS_SET: "Updating Freedom Financial access",
  APPROVAL: "Waiting for approval",
  ERROR: "Error",
});

export function createSubmissionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `chief-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function conversationLabel(session) {
  const title = typeof session?.title === "string" ? session.title.trim() : "";
  if (title) return title;
  const created = session?.createdAt ? new Date(session.createdAt) : null;
  if (created && !Number.isNaN(created.getTime())) {
    const formatted = created.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    return `Conversation · ${formatted}`;
  }
  return "Conversation";
}

export function formatChiefTime(value, now = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.floor((now - date.getTime()) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function statusForToolName(name) {
  if (name === "web_search") return CHIEF_STATUS.WEB_SEARCH;
  if (name === "freedom_financial_access_set") return CHIEF_STATUS.MODULE_ACCESS_SET;
  if (name === "freedom_financial_access_status") return CHIEF_STATUS.MODULE_ACCESS;
  if (FINANCE_TOOLS.has(name)) return CHIEF_STATUS.FINANCE;
  return CHIEF_STATUS.TOOL;
}

export function isVisibleAssistantDelta(msg) {
  if (msg?.type !== "assistant_content_delta") return false;
  if (msg.phase === "reasoning" || msg.phase === "commentary") return false;
  return typeof msg.delta === "string" && msg.delta.length > 0;
}

export function publicTranscriptMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const visible = [];
  for (const message of messages) {
    if (message?.role !== "user" && message?.role !== "assistant") continue;
    if (typeof message.text !== "string" || !message.text.trim()) continue;
    visible.push({
      id: `${message.role}-${visible.length}`,
      role: message.role,
      text: message.text,
    });
  }
  return visible;
}

export function isActiveChiefTurn(turnStatus) {
  return turnStatus === "continuing" || turnStatus === "running";
}

// A question typed while CHIEF is still answering stays in the composer.
// It is not submitted into the unresolved turn.
export function acceptChiefSubmission({ busy = false, turnStatus = "", text = "" } = {}) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return { action: "ignore", draft: "" };
  if (busy || isActiveChiefTurn(turnStatus)) return { action: "preserve", draft: trimmed };
  return { action: "send", draft: "" };
}

// Navigation mounts a fresh page. The saved conversation is the source of
// truth: an unfinished turn is followed, and a settled turn with no answer
// keeps that failure.
export function restoredChiefTurn({
  messages,
  turnStatus = "",
  heldPrompt = "",
  turnError = "",
} = {}) {
  const held = typeof heldPrompt === "string" ? heldPrompt.trim() : "";
  const live = isActiveChiefTurn(turnStatus);
  const missingStatus = turnStatus === "empty" || turnStatus === "failed" ? turnStatus : "";
  const missing = missingStatus
    ? (typeof turnError === "string" && turnError.trim()) ||
      (missingStatus === "failed" ? "CHIEF could not finish that response." : MISSING_CHIEF_ANSWER)
    : "";
  return {
    messages: Array.isArray(messages) ? messages : [],
    turnStatus: live ? turnStatus : missing ? missingStatus : held ? "continuing" : "",
    status: missing ? CHIEF_STATUS.ERROR : live || held ? CHIEF_STATUS.WORKING : CHIEF_STATUS.READY,
    streamText: "",
    error: missing,
    follow: !missing && (live || Boolean(held)),
    heldPrompt: held,
  };
}

// Speech waits until the Managed Agents turn has actually settled. A budget
// handoff ("continuing") and a suspension are not finished replies.
export function isSpeakableTurn(turnStatus) {
  return (
    turnStatus !== "continuing" &&
    turnStatus !== "running" &&
    turnStatus !== "suspended" &&
    turnStatus !== "aborted" &&
    turnStatus !== "rejected" &&
    turnStatus !== "empty" &&
    turnStatus !== "failed"
  );
}

export function initialTurnState(sessionId = null) {
  return {
    status: CHIEF_STATUS.WORKING,
    streamText: "",
    sessionId,
    approval: null,
    error: "",
    finished: false,
    turnStatus: null,
  };
}

function sessionIdFrom(msg, fallback) {
  return typeof msg?.session_id === "string" && msg.session_id ? msg.session_id : fallback;
}

export function applyChiefEvent(state, event) {
  const msg = event?.msg;
  if (!msg || typeof msg.type !== "string") return state;
  switch (msg.type) {
    case "turn_started": {
      const nextTurnId = typeof msg.turn_id === "string" ? msg.turn_id : "";
      if (state.held && !state.boundTurnId) {
        return {
          ...state,
          status: CHIEF_STATUS.WORKING,
          finished: false,
          turnStatus: "running",
        };
      }
      const switching = Boolean(
        state.boundTurnId && nextTurnId && nextTurnId !== state.boundTurnId
      );
      return {
        ...state,
        boundTurnId: nextTurnId || state.boundTurnId || null,
        turnId: nextTurnId || state.turnId || null,
        streamText: switching ? "" : state.streamText,
        status: !switching && state.streamText ? CHIEF_STATUS.RESPONDING : CHIEF_STATUS.WORKING,
        finished: false,
        turnStatus: "running",
      };
    }
    case "message": {
      const delivery = msg.delivery === "queue" ? "queue" : msg.delivery === "turn" ? "turn" : "";
      const text = typeof msg.text === "string" ? msg.text : "";
      if (delivery === "queue") {
        return {
          ...state,
          held: true,
          boundTurnId: null,
          heldText: text || state.heldText || "",
          finished: false,
          turnStatus: "continuing",
          status: CHIEF_STATUS.WORKING,
        };
      }
      if (delivery === "turn" && typeof msg.turn_id === "string" && msg.turn_id) {
        const switching = Boolean(state.boundTurnId && state.boundTurnId !== msg.turn_id);
        return {
          ...state,
          held: false,
          boundTurnId: msg.turn_id,
          turnId: msg.turn_id,
          streamText: switching ? "" : state.streamText,
          acceptedUserText: text,
          finished: false,
          turnStatus: "running",
          status: CHIEF_STATUS.WORKING,
        };
      }
      return state;
    }
    case "assistant_content_delta": {
      const sessionId = sessionIdFrom(msg, state.sessionId);
      if (state.held && !state.boundTurnId) return { ...state, sessionId };
      if (state.boundTurnId && msg.turn_id && msg.turn_id !== state.boundTurnId) {
        return { ...state, sessionId };
      }
      if (!isVisibleAssistantDelta(msg)) return { ...state, sessionId };
      return {
        ...state,
        sessionId,
        status: CHIEF_STATUS.RESPONDING,
        streamText: `${state.streamText}${msg.delta}`,
      };
    }
    case "tool_call_begin":
      if (state.boundTurnId && msg.turn_id && msg.turn_id !== state.boundTurnId) return state;
      if (state.held && !state.boundTurnId) return state;
      return { ...state, status: statusForToolName(msg.name) };
    case "tool_call_end":
      return { ...state, status: state.approval ? CHIEF_STATUS.APPROVAL : CHIEF_STATUS.WORKING };
    case "exec_approval_request":
      return {
        ...state,
        status: CHIEF_STATUS.APPROVAL,
        approval:
          typeof msg.id === "string" && msg.id
            ? { id: msg.id, turnId: typeof msg.turn_id === "string" ? msg.turn_id : "" }
            : state.approval,
      };
    case "session_configured": {
      const turnStatus = typeof msg.status === "string" ? msg.status : null;
      const suspended = turnStatus === "suspended";
      const active = isActiveChiefTurn(turnStatus);
      const missing = turnStatus === "empty" || turnStatus === "failed";
      return {
        ...state,
        sessionId: sessionIdFrom(msg, state.sessionId),
        turnStatus,
        status: missing
          ? CHIEF_STATUS.ERROR
          : suspended
            ? CHIEF_STATUS.APPROVAL
            : active
              ? state.streamText
                ? CHIEF_STATUS.RESPONDING
                : CHIEF_STATUS.WORKING
              : CHIEF_STATUS.READY,
        error: missing ? state.error || MISSING_CHIEF_ANSWER : state.error,
        finished: !suspended && !active,
        approval: suspended ? state.approval : null,
      };
    }
    case "error":
    case "submission_rejected":
      return {
        ...state,
        status: CHIEF_STATUS.ERROR,
        error: chiefUserMessage(
          typeof msg.message === "string" && msg.message.trim()
            ? msg.message.trim()
            : "CHIEF could not finish that turn."
        ),
        finished: true,
        turnStatus: "rejected",
      };
    case "turn_aborted":
      return { ...state, status: CHIEF_STATUS.READY, finished: true, turnStatus: "aborted" };
    case "model_changed":
      return {
        ...state,
        modelRoute:
          typeof msg.route === "string" && msg.route ? msg.route : (state.modelRoute ?? null),
      };
    default:
      return state;
  }
}

export function consumeSseBuffer(buffer, chunk) {
  const events = [];
  let next = `${buffer}${chunk}`;
  let splitAt = next.indexOf("\n\n");
  while (splitAt !== -1) {
    const frame = next.slice(0, splitAt);
    next = next.slice(splitAt + 2);
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) events.push(JSON.parse(data));
    splitAt = next.indexOf("\n\n");
  }
  return { buffer: next, events };
}

export function chiefUserMessage(message) {
  if (message === "session not found") return "That conversation is not available.";
  if (message === "Missing bearer token." || message === "Unauthorized") {
    return "Sign in to talk with CHIEF.";
  }
  if (typeof message === "string") {
    const trimmed = message.trim();
    if (
      trimmed &&
      trimmed.length <= 180 &&
      !trimmed.includes("\n") &&
      !/prisma|stack|node_modules|TypeError|ReferenceError/i.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return "CHIEF could not complete that request.";
}

export function messageSubmission(text) {
  return {
    id: createSubmissionId(),
    op: { type: "message", message: { text } },
  };
}

export function resumeSubmission(sessionId) {
  return {
    id: createSubmissionId(),
    op: { type: "resume_session", session_id: sessionId },
  };
}

export function modelSubmission(route) {
  return {
    id: createSubmissionId(),
    op: { type: "set_model", route },
  };
}

export function approvalSubmission(approvalId, decision) {
  return {
    id: createSubmissionId(),
    op: {
      type: "exec_approval",
      id: approvalId,
      decision: decision === "deny" ? { denied: { rejection: "Not approved." } } : "approved",
    },
  };
}

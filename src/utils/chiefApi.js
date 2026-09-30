// Authenticated client for the CHIEF conversation lifecycle.
// Network only. Event mapping lives in chiefProtocol.js.

import { ApiRequestError, buildAuthenticatedHeaders } from "./api.js";
import {
  approvalSubmission,
  chiefUserMessage,
  consumeSseBuffer,
  messageSubmission,
} from "./chiefProtocol.js";

export {
  CHIEF_STATUS,
  applyChiefEvent,
  approvalSubmission,
  conversationLabel,
  createSubmissionId,
  formatChiefTime,
  initialTurnState,
  messageSubmission,
  publicTranscriptMessages,
} from "./chiefProtocol.js";

async function readChiefError(response) {
  const payload = await response.json().catch(() => ({}));
  if (response.status >= 500) {
    return new ApiRequestError("CHIEF could not complete that request.", {
      status: response.status,
    });
  }
  const raw =
    typeof payload?.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : typeof payload?.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : response.status === 404
          ? "session not found"
          : "";
  return new ApiRequestError(chiefUserMessage(raw), {
    status: response.status,
    payload: response.status === 404 ? { error: "session not found" } : undefined,
  });
}

async function chiefJson(path, { user, method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: await buildAuthenticatedHeaders(body ? { "Content-Type": "application/json" } : {}, {
      user,
    }),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw await readChiefError(response);
  return response.json();
}

export function fetchChiefSessions(user) {
  return chiefJson("/api/chief/sessions", { user });
}

export function fetchChiefHistory(user, sessionId) {
  const query = new URLSearchParams({ session_id: sessionId });
  return chiefJson(`/api/chief/history?${query.toString()}`, { user });
}

export async function fetchChiefPendingApproval(user, sessionId) {
  const payload = await chiefJson("/api/chief/approvals", { user });
  const match = (Array.isArray(payload?.approvals) ? payload.approvals : []).find(
    (entry) => entry?.sessionId === sessionId && typeof entry.id === "string" && entry.id
  );
  if (!match) return null;
  return {
    id: match.id,
    turnId: typeof match.turnId === "string" ? match.turnId : "",
  };
}

export async function streamChiefChat({ user, sessionId = null, text, onEvent, signal }) {
  const body = { submission: messageSubmission(text) };
  if (sessionId) body.session_id = sessionId;
  const response = await fetch("/api/chief/chat", {
    method: "POST",
    headers: await buildAuthenticatedHeaders(
      {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      { user }
    ),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) throw await readChiefError(response);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const consumed = consumeSseBuffer(buffer, decoder.decode(value, { stream: true }));
    buffer = consumed.buffer;
    for (const event of consumed.events) onEvent(event);
  }
  const tail = consumeSseBuffer(buffer, decoder.decode());
  for (const event of tail.events) onEvent(event);
}

export function decideChiefApproval({ user, sessionId, approvalId, decision }) {
  return chiefJson("/api/chief/approvals", {
    user,
    method: "POST",
    body: {
      session_id: sessionId,
      submission: approvalSubmission(approvalId, decision),
    },
  });
}

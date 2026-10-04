// Authenticated client for the CHIEF conversation lifecycle.
// Network only. Event mapping lives in chiefProtocol.js.

import { ApiRequestError, buildAuthenticatedHeaders } from "./api.js";
import {
  approvalSubmission,
  chiefUserMessage,
  consumeSseBuffer,
  messageSubmission,
  modelSubmission,
} from "./chiefProtocol.js";
import { accessWord, emptyRoomAccess, normalizeAccessInventory } from "./chiefRoom.js";
import { sidebarSearchPath } from "./chiefSidebar.js";

export {
  CHIEF_STATUS,
  applyChiefEvent,
  approvalSubmission,
  conversationLabel,
  createSubmissionId,
  formatChiefTime,
  initialTurnState,
  messageSubmission,
  modelSubmission,
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

export function fetchChiefSessions(user, { archived = false } = {}) {
  const query = archived ? "?archived=1" : "";
  return chiefJson(`/api/chief/sessions${query}`, { user });
}

export function fetchChiefSessionSearch(user, query) {
  return chiefJson(sidebarSearchPath(query), { user });
}

export function renameChiefSession(user, sessionId, title) {
  return chiefJson("/api/chief/sessions", {
    user,
    method: "PATCH",
    body: { session_id: sessionId, title },
  });
}

export function setChiefSessionArchived(user, sessionId, archived) {
  return chiefJson("/api/chief/sessions", {
    user,
    method: "PATCH",
    body: { session_id: sessionId, archived },
  });
}

export function deleteChiefSession(user, sessionId) {
  return chiefJson("/api/chief/sessions", {
    user,
    method: "DELETE",
    body: { session_id: sessionId, confirm: true },
  });
}

export function fetchChiefModels(user) {
  return chiefJson("/api/chief/models", { user });
}

export async function fetchChiefRoomAccess(user) {
  const next = emptyRoomAccess();
  try {
    const payload = await chiefJson("/api/chief/access", { user });
    next.money = accessWord(payload?.money);
    next.web = accessWord(payload?.web);
    if (payload?.inventory && typeof payload.inventory === "object") {
      next.inventory = normalizeAccessInventory(payload.inventory);
    }
  } catch {
    next.money = "unavailable";
    next.web = "unavailable";
  }
  return next;
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

export async function selectChiefModel({ user, sessionId = null, route }) {
  const body = { submission: modelSubmission(route) };
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
  });
  if (!response.ok) throw await readChiefError(response);
  const consumed = consumeSseBuffer("", await response.text());
  let nextSessionId = sessionId;
  let selected = null;
  let error = "";
  for (const event of consumed.events) {
    const msg = event?.msg;
    if (!msg) continue;
    if (msg.type === "model_changed" && typeof msg.route === "string") selected = msg.route;
    if (msg.type === "session_configured" && typeof msg.session_id === "string" && msg.session_id) {
      nextSessionId = msg.session_id;
    }
    if (
      (msg.type === "error" || msg.type === "submission_rejected") &&
      typeof msg.message === "string"
    ) {
      error = chiefUserMessage(msg.message);
    }
  }
  if (error) throw new ApiRequestError(error);
  if (!selected) throw new ApiRequestError("CHIEF could not complete that request.");
  return { sessionId: nextSessionId, route: selected };
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

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
import {
  accessWord,
  emptyRoomAccess,
  normalizeAccessInventory,
  normalizeConnectedSystems,
} from "./chiefRoom.js";
import { voiceConnectionState } from "./chiefVoiceStatus.js";
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
    next.systems = normalizeConnectedSystems(payload?.systems);
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

async function readVoiceError(response) {
  const payload = await response.json().catch(() => ({}));
  const raw = typeof payload?.error === "string" ? payload.error.trim() : "";
  return new ApiRequestError(
    chiefUserMessage(raw || `ElevenLabs request failed (${response.status}).`),
    { status: response.status }
  );
}

export async function fetchChiefVoices(user) {
  const response = await fetch("/api/chief/voices", {
    method: "GET",
    headers: await buildAuthenticatedHeaders({}, { user }),
  });
  if (!response.ok) throw await readVoiceError(response);
  return response.json();
}

export async function fetchChiefSpeech({ user, text, voiceId, voiceSettings, signal }) {
  const settings = voiceSettings && typeof voiceSettings === "object" ? voiceSettings : {};
  const response = await fetch("/api/chief/speak", {
    method: "POST",
    headers: await buildAuthenticatedHeaders({ "Content-Type": "application/json" }, { user }),
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      voice_settings: {
        speed: settings.speed,
        stability: settings.stability,
        similarity_boost: settings.similarityBoost ?? settings.similarity_boost,
      },
    }),
    signal,
  });
  if (!response.ok || !response.body) throw await readVoiceError(response);
  return response;
}

export function fetchChiefVoiceConfig(user) {
  return chiefJson("/api/chief/voice", { user });
}

// Voice-sheet list. Named apart from fetchChiefVoices, which serves the dock
// at GET /api/chief/voices. This one stays on GET /api/chief/voice/voices.
export function fetchChiefVoiceList(user) {
  return chiefJson("/api/chief/voice/voices", { user });
}

export async function fetchChiefVoiceCatalog(user) {
  const headers = await buildAuthenticatedHeaders({}, { user });
  const configResponse = await fetch("/api/chief/voice", { headers });
  const configPayload = await configResponse.json().catch(() => ({}));
  if (!configResponse.ok) {
    return {
      status: voiceConnectionState({ code: configPayload?.code }),
      voices: [],
      config: null,
    };
  }
  const voicesResponse = await fetch("/api/chief/voice/voices", {
    headers: await buildAuthenticatedHeaders({}, { user }),
  });
  const voicesPayload = await voicesResponse.json().catch(() => ({}));
  if (!voicesResponse.ok) {
    return {
      status: voiceConnectionState({
        configured: configPayload?.configured === true,
        code: voicesPayload?.code || "provider_error",
      }),
      voices: [],
      config: {
        provider: "elevenlabs",
        configured: configPayload?.configured === true,
        defaultVoiceId:
          typeof configPayload?.defaultVoiceId === "string" ? configPayload.defaultVoiceId : "",
        defaultModelId:
          typeof configPayload?.defaultModelId === "string" ? configPayload.defaultModelId : "",
        fallbackAvailable: configPayload?.fallbackAvailable === true,
      },
    };
  }
  const configured = configPayload?.configured === true && voicesPayload?.configured !== false;
  return {
    status: voiceConnectionState({
      configured,
      code: voicesPayload?.status === "not_configured" ? "not_configured" : "",
    }),
    voices: Array.isArray(voicesPayload?.voices) ? voicesPayload.voices : [],
    config: {
      provider: "elevenlabs",
      configured: configPayload?.configured === true,
      defaultVoiceId:
        typeof configPayload?.defaultVoiceId === "string" ? configPayload.defaultVoiceId : "",
      defaultModelId:
        typeof configPayload?.defaultModelId === "string" ? configPayload.defaultModelId : "",
      fallbackAvailable: configPayload?.fallbackAvailable === true,
    },
  };
}

export async function fetchChiefWorkforceLink(user) {
  try {
    const payload = await chiefJson("/api/chief/workforce/report-key", { user });
    return { readable: true, active: payload?.active === true };
  } catch {
    return { readable: false, active: false };
  }
}

export async function requestChiefSpeech(user, body, { signal } = {}) {
  const response = await fetch("/api/chief/voice", {
    method: "POST",
    headers: await buildAuthenticatedHeaders({ "Content-Type": "application/json" }, { user }),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const code = typeof payload?.code === "string" ? payload.code : "provider_error";
    const error = new ApiRequestError(
      chiefUserMessage(
        typeof payload?.error === "string" ? payload.error : "CHIEF could not speak."
      ),
      { status: response.status }
    );
    error.code = code;
    throw error;
  }
  return response.arrayBuffer();
}

export function recordChiefVoiceTrace(user, body) {
  return chiefJson("/api/chief/voice/trace", {
    user,
    method: "POST",
    body,
  });
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

import { buildAuthenticatedHeaders, parseApiResponse } from "./api.js";

// Fetch wrappers for the Freedom OS agent platform API (Phase 5). The Phase 6
// UI consumes these; no UI is built here. Every call authenticates with the
// user's Firebase token via buildAuthenticatedHeaders (same contract as
// api.js: `options.user` may carry the Firebase user during auth startup).

async function requestJson(path, { method = "GET", body, options = {} } = {}) {
  const headers = await buildAuthenticatedHeaders(
    body !== undefined ? { "Content-Type": "application/json" } : {},
    options
  );
  const response = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return parseApiResponse(response);
}

// ── CEO Agent ────────────────────────────────────────────────────────────────

export function fetchCeoAgent(options = {}) {
  return requestJson("/api/agents/ceo", { options });
}

/** Updatable fields: name, personalityPreset (enum), avatarKey (preset slug). */
export function updateCeoAgent({ name, personalityPreset, avatarKey } = {}, options = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (personalityPreset !== undefined) body.personalityPreset = personalityPreset;
  if (avatarKey !== undefined) body.avatarKey = avatarKey;
  return requestJson("/api/agents/ceo", { method: "PUT", body, options });
}

export function fetchCeoProfile(options = {}) {
  return requestJson("/api/agents/ceo/profile", { options });
}

/** ops: [{ action: "update"|"delete", category?, id, text? }] */
export function updateCeoProfile(ops, options = {}) {
  return requestJson("/api/agents/ceo/profile", { method: "PATCH", body: { ops }, options });
}

export function fetchCeoDocuments(options = {}) {
  return requestJson("/api/agents/ceo/documents", { options });
}

/** documents: [{ filename, mimeType, content }] — text files only. */
export function uploadCeoDocuments(documents, options = {}) {
  return requestJson("/api/agents/ceo/documents", {
    method: "POST",
    body: { documents },
    options,
  });
}

export function deleteCeoDocument(documentId, options = {}) {
  return requestJson(
    `/api/agents/ceo/documents?id=${encodeURIComponent(documentId)}`,
    { method: "DELETE", options }
  );
}

export function fetchCeoDigest({ refresh = false } = {}, options = {}) {
  const query = refresh ? "?refresh=true" : "";
  return requestJson(`/api/agents/ceo/digest${query}`, { options });
}

export function regenerateCeoDigest(options = {}) {
  return requestJson("/api/agents/ceo/digest", { method: "POST", body: {}, options });
}

/** Visible CEO chat history (creation-state bookkeeping rows are omitted). */
export function fetchCeoChatHistory(options = {}) {
  return requestJson("/api/agents/ceo/chat", { options });
}

/**
 * CEO chat. Pass mode: "create_agent" to start the "+ New Agent" creation
 * flow; while a creation session is active every message continues it. The
 * response contains { reply, messageId } and, on the confirming turn,
 * { agentCreated: { id, name, agentType } }.
 */
export function sendCeoChatMessage({ message, relatedRunId = null, mode } = {}, options = {}) {
  const body = { message, ...(relatedRunId ? { relatedRunId } : {}), ...(mode ? { mode } : {}) };
  return requestJson("/api/agents/ceo/chat", { method: "POST", body, options });
}

/**
 * One-shot onboarding: { financialGoals?, lifeContext?, priorities?,
 * communicationPrefs?, ceoName?, personalityPreset?, avatarKey? }.
 * Returns 409 if onboarding was already completed.
 */
export function submitCeoOnboarding(answers, options = {}) {
  return requestJson("/api/agents/onboarding", { method: "POST", body: answers, options });
}

// ── Sub-agents ───────────────────────────────────────────────────────────────

export function fetchAgents(options = {}) {
  return requestJson("/api/agents", { options });
}

/**
 * Create an agent: { agentType, name, instructions?, definitionOfDone,
 * schedulePreset?, scheduleWeekday?, toolAccess? }. New agents are always
 * READ_ONLY and ACTIVE (the server pins both).
 */
export function createAgent(payload, options = {}) {
  return requestJson("/api/agents", { method: "POST", body: payload, options });
}

export function updateAgent(agentId, payload, options = {}) {
  return requestJson(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: payload,
    options,
  });
}

export function deleteAgent(agentId, options = {}) {
  return requestJson(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
    options,
  });
}

export function triggerAgentRun(agentId, options = {}) {
  return requestJson(`/api/agents/${encodeURIComponent(agentId)}/run`, {
    method: "POST",
    body: {},
    options,
  });
}

export function fetchAgentRuns(agentId, { limit, before } = {}, options = {}) {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (before) params.set("before", before instanceof Date ? before.toISOString() : String(before));
  const query = params.toString() ? `?${params.toString()}` : "";
  return requestJson(`/api/agents/${encodeURIComponent(agentId)}/runs${query}`, { options });
}

export function fetchAgentRun(agentId, runId, options = {}) {
  return requestJson(
    `/api/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    { options }
  );
}

/**
 * Emails one run's report to the user's own VERIFIED account address.
 * The server rejects unverified accounts; no other recipient is possible.
 */
export function emailAgentRun(agentId, runId, options = {}) {
  return requestJson(
    `/api/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    { method: "POST", body: {}, options }
  );
}

export function fetchAgentChatHistory(agentId, options = {}) {
  return requestJson(`/api/agents/${encodeURIComponent(agentId)}/chat`, { options });
}

export function sendAgentChatMessage(agentId, { message, relatedRunId = null } = {}, options = {}) {
  const body = { message, ...(relatedRunId ? { relatedRunId } : {}) };
  return requestJson(`/api/agents/${encodeURIComponent(agentId)}/chat`, {
    method: "POST",
    body,
    options,
  });
}

// ── Notifications ────────────────────────────────────────────────────────────

export function fetchNotifications({ unreadOnly = false } = {}, options = {}) {
  const query = unreadOnly ? "?unreadOnly=true" : "";
  return requestJson(`/api/notifications${query}`, { options });
}

export function markNotificationRead(notificationId, options = {}) {
  return requestJson(`/api/notifications/${encodeURIComponent(notificationId)}`, {
    method: "PATCH",
    body: {},
    options,
  });
}

// ── Admin ────────────────────────────────────────────────────────────────────

export function fetchAdminUsage(options = {}) {
  return requestJson("/api/admin/usage", { options });
}

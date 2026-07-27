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

/** Updatable fields: name, personalityPreset, avatarKey, model, defaultSubAgentModel. */
export function updateCeoAgent(
  { name, personalityPreset, avatarKey, model, defaultSubAgentModel } = {},
  options = {}
) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (personalityPreset !== undefined) body.personalityPreset = personalityPreset;
  if (avatarKey !== undefined) body.avatarKey = avatarKey;
  if (model !== undefined) body.model = model;
  if (defaultSubAgentModel !== undefined) body.defaultSubAgentModel = defaultSubAgentModel;
  return requestJson("/api/agents/ceo", { method: "PUT", body, options });
}

export function fetchCeoProfile(options = {}) {
  return requestJson("/api/agents/ceo/profile", { options });
}

/** ops: [{ action: "update"|"delete", category?, id, text? }] */
export function updateCeoProfile(ops, options = {}) {
  return requestJson("/api/agents/ceo/profile", { method: "PATCH", body: { ops }, options });
}

/** Cached long-form "Read your Profile" newsletter (may be null). */
export function fetchCeoNarrativeProfile(options = {}) {
  return requestJson("/api/agents/ceo/profile/narrative", { options });
}

/** Generate or refresh the long-form narrative profile and persist it. */
export function generateCeoNarrativeProfile(options = {}) {
  return requestJson("/api/agents/ceo/profile/narrative", { method: "POST", body: {}, options });
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
export function fetchCeoChatHistory({ conversationId } = {}, options = {}) {
  const params = new URLSearchParams();
  if (conversationId) params.set("conversationId", conversationId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return requestJson(`/api/agents/ceo/chat${query}`, { options });
}

/**
 * CEO chat — single brain for ask / create / run. Optional conversationId
 * selects a thread; omitted → newest non-system conversation.
 */
export function sendCeoChatMessage(
  { message, relatedRunId = null, conversationId = null } = {},
  options = {}
) {
  const body = {
    message,
    ...(relatedRunId ? { relatedRunId } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
  return requestJson("/api/agents/ceo/chat", { method: "POST", body, options });
}

/** List non-system CEO conversations (newest updatedAt first). */
export function fetchCeoConversations({ limit, before, includeArchived = false } = {}, options = {}) {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (before) params.set("before", before instanceof Date ? before.toISOString() : String(before));
  if (includeArchived) params.set("includeArchived", "true");
  const query = params.toString() ? `?${params.toString()}` : "";
  return requestJson(`/api/agents/ceo/conversations${query}`, { options });
}

export function createCeoConversation({ title = null } = {}, options = {}) {
  return requestJson("/api/agents/ceo/conversations", {
    method: "POST",
    body: title != null ? { title } : {},
    options,
  });
}

export function updateCeoConversation(conversationId, payload, options = {}) {
  return requestJson(`/api/agents/ceo/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    body: payload,
    options,
  });
}

export function deleteCeoConversation(conversationId, options = {}) {
  return requestJson(`/api/agents/ceo/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
    options,
  });
}

export function fetchCeoConversationMessages(conversationId, { limit, before } = {}, options = {}) {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (before) params.set("before", before instanceof Date ? before.toISOString() : String(before));
  const query = params.toString() ? `?${params.toString()}` : "";
  return requestJson(
    `/api/agents/ceo/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
    { options }
  );
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

export function fetchAgentChatHistory(agentId, { conversationId } = {}, options = {}) {
  const params = new URLSearchParams();
  if (conversationId) params.set("conversationId", conversationId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return requestJson(`/api/agents/${encodeURIComponent(agentId)}/chat${query}`, { options });
}

export function sendAgentChatMessage(
  agentId,
  { message, relatedRunId = null, conversationId = null } = {},
  options = {}
) {
  const body = {
    message,
    ...(relatedRunId ? { relatedRunId } : {}),
    ...(conversationId ? { conversationId } : {}),
  };
  return requestJson(`/api/agents/${encodeURIComponent(agentId)}/chat`, {
    method: "POST",
    body,
    options,
  });
}

export function fetchAgentConversations(agentId, { limit, before, includeArchived = false } = {}, options = {}) {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (before) params.set("before", before instanceof Date ? before.toISOString() : String(before));
  if (includeArchived) params.set("includeArchived", "true");
  const query = params.toString() ? `?${params.toString()}` : "";
  return requestJson(`/api/agents/${encodeURIComponent(agentId)}/conversations${query}`, {
    options,
  });
}

export function createAgentConversation(agentId, { title = null } = {}, options = {}) {
  return requestJson(`/api/agents/${encodeURIComponent(agentId)}/conversations`, {
    method: "POST",
    body: title != null ? { title } : {},
    options,
  });
}

export function updateAgentConversation(agentId, conversationId, payload, options = {}) {
  return requestJson(
    `/api/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}`,
    { method: "PATCH", body: payload, options }
  );
}

export function deleteAgentConversation(agentId, conversationId, options = {}) {
  return requestJson(
    `/api/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE", options }
  );
}

export function fetchAgentConversationMessages(
  agentId,
  conversationId,
  { limit, before } = {},
  options = {}
) {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (before) params.set("before", before instanceof Date ? before.toISOString() : String(before));
  const query = params.toString() ? `?${params.toString()}` : "";
  return requestJson(
    `/api/agents/${encodeURIComponent(agentId)}/conversations/${encodeURIComponent(conversationId)}/messages${query}`,
    { options }
  );
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

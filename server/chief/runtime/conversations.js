// Search and read projections over the caller's existing checkpoint store.
// There is no second transcript table. Scheduled sessions are not conversations.

import { projectInteractiveHistory } from "./history.js";
import { isScheduledSession, projectInteractiveSessions } from "./sessions.js";

export const CONVERSATION_SEARCH_SCAN_LIMIT = 40;
export const CONVERSATION_SEARCH_RESULT_LIMIT = 8;
const SNIPPET_MAX = 240;

export function parseConversationSearch(params) {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { error: "Say what to search for." };
  }
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (params.query != null && typeof params.query !== "string") {
    return { error: "Say what to search for." };
  }
  if (query.length > 200) return { error: "That search is too long." };
  const after = parseBound(params.after, "after");
  if (after?.error) return after;
  const before = parseBound(params.before, "before");
  if (before?.error) return before;
  if (!query && !after?.value && !before?.value) return { error: "Say what to search for." };
  if (params.includeArchived != null && typeof params.includeArchived !== "boolean") {
    return { error: "includeArchived must be a boolean" };
  }
  return {
    query,
    after: after?.value ?? null,
    before: before?.value ?? null,
    includeArchived: params.includeArchived === true,
  };
}

function parseBound(value, name) {
  if (value == null || value === "") return { value: null };
  if (typeof value !== "string") return { error: `${name} must be a date` };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: `${name} must be a date` };
  return { value: date.toISOString() };
}

function inRange(updatedAt, after, before) {
  if (!updatedAt) return !after && !before;
  if (after && updatedAt < after) return false;
  if (before && updatedAt > before) return false;
  return true;
}

function clip(value) {
  const text = String(value);
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text;
}

export async function searchOwnedConversations(store, userId, params) {
  const parsed = parseConversationSearch(params);
  if (parsed.error) return parsed;
  const rows = await store.listOwnedSessions(userId);
  const visible = projectInteractiveSessions(rows, { archivedOnly: false });
  const archived = parsed.includeArchived
    ? projectInteractiveSessions(rows, { archivedOnly: true })
    : [];
  const candidates = [...visible, ...archived]
    .filter((session) => inRange(session.updatedAt, parsed.after, parsed.before))
    .slice(0, CONVERSATION_SEARCH_SCAN_LIMIT);
  const needle = parsed.query.toLowerCase();
  const results = [];
  for (const session of candidates) {
    if (isScheduledSession(session)) continue;
    const record = await store.load(userId, session.sessionId);
    const history = projectInteractiveHistory(record);
    if (history.error) continue;
    const messages = history.messages.filter((message) => typeof message.text === "string" && message.text);
    const titleHit = needle && (session.title || "").toLowerCase().includes(needle);
    const matched = needle
      ? messages.filter((message) => message.text.toLowerCase().includes(needle))
      : [];
    if (needle && !titleHit && matched.length === 0) continue;
    results.push({
      sessionId: session.sessionId,
      title: session.title,
      updatedAt: session.updatedAt,
      snippets: matched.slice(0, 3).map((message) => ({
        role: message.role,
        text: clip(message.text),
      })),
    });
    if (results.length >= CONVERSATION_SEARCH_RESULT_LIMIT) break;
  }
  return { results };
}

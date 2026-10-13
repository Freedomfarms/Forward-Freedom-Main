// View model for the CHIEF conversation workspace.
// Grouping and filters only. Persistence stays on the session routes.

import { formatChiefTime } from "./chiefProtocol.js";

export const CONVERSATION_FILTERS = Object.freeze([
  { id: "all", label: "All" },
  { id: "recent", label: "Recent" },
  { id: "archived", label: "Archived" },
]);

export const CONVERSATION_GROUP_LABELS = Object.freeze({
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 Days",
  older: "Older",
});

const GROUP_ORDER = ["today", "yesterday", "week", "older"];

function startOfLocalDay(time) {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function shiftLocalDay(time, days) {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

export function conversationProviderLabel(provider) {
  if (provider === "claude") return "Claude";
  if (provider === "chatgpt") return "ChatGPT";
  if (provider === "chief") return "CHIEF";
  return "";
}

export function conversationSearchTarget(session) {
  const sessionId = typeof session?.sessionId === "string" ? session.sessionId : "";
  const provider =
    session?.provider === "claude" || session?.provider === "chatgpt" ? session.provider : "chief";
  if (provider === "chief") return { kind: "chief", sessionId, provider };
  return { kind: "archive", sessionId, provider };
}

export function conversationUpdatedAt(session) {
  const raw = session?.updatedAt || session?.createdAt || "";
  const time = new Date(raw).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function conversationAgeBucket(timestamp, now = Date.now()) {
  if (!timestamp) return "older";
  const startToday = startOfLocalDay(now);
  if (timestamp >= startToday) return "today";
  if (timestamp >= shiftLocalDay(startToday, -1)) return "yesterday";
  if (timestamp >= shiftLocalDay(startToday, -7)) return "week";
  return "older";
}

export function conversationWhen(session, now = Date.now()) {
  const raw = formatChiefTime(session?.updatedAt || session?.createdAt, now);
  if (!raw) return "";
  if (raw === "now") return "now";
  return /^\d+[mhd]$/.test(raw) ? `${raw} ago` : raw;
}

function normalizeFilter(filter) {
  return filter === "recent" || filter === "archived" ? filter : "all";
}

function compareSessions(left, right) {
  const delta = conversationUpdatedAt(right) - conversationUpdatedAt(left);
  if (delta !== 0) return delta;
  const leftId = String(left?.sessionId || "");
  const rightId = String(right?.sessionId || "");
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

function emptyLabelFor(filter, searching, count) {
  if (count > 0) return "";
  if (searching) return "No conversations found";
  if (filter === "recent") return "No recent conversations.";
  if (filter === "archived") return "No archived conversations.";
  return "No conversations yet.";
}

export function buildConversationView({
  sessions = [],
  archivedSessions = [],
  query = "",
  searchResults = [],
  filter = "all",
  now = Date.now(),
} = {}) {
  const activeFilter = normalizeFilter(filter);
  const activeQuery = typeof query === "string" ? query.trim() : "";
  const searching = Boolean(activeQuery);
  const source = searching
    ? Array.isArray(searchResults)
      ? searchResults
      : []
    : activeFilter === "archived"
      ? Array.isArray(archivedSessions)
        ? archivedSessions
        : []
      : Array.isArray(sessions)
        ? sessions
        : [];

  const rows = [];
  const seen = new Set();
  for (const session of source) {
    if (!session?.sessionId || seen.has(session.sessionId)) continue;
    const archived = searching ? Boolean(session.archived) : activeFilter === "archived";
    if (activeFilter === "archived" && !archived) continue;
    if (archived && activeFilter !== "archived" && !(searching && activeFilter === "all")) continue;
    if (
      activeFilter === "recent" &&
      conversationAgeBucket(conversationUpdatedAt(session), now) === "older"
    ) {
      continue;
    }
    seen.add(session.sessionId);
    rows.push(session);
  }
  rows.sort(compareSessions);

  const buckets = { today: [], yesterday: [], week: [], older: [] };
  for (const session of rows) {
    buckets[conversationAgeBucket(conversationUpdatedAt(session), now)].push(session);
  }

  return {
    searching,
    filter: activeFilter,
    count: rows.length,
    groups: GROUP_ORDER.flatMap((id) =>
      buckets[id].length
        ? [{ id, label: CONVERSATION_GROUP_LABELS[id], sessions: buckets[id] }]
        : []
    ),
    emptyLabel: emptyLabelFor(activeFilter, searching, rows.length),
  };
}

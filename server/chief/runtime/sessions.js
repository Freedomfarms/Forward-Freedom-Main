// Caller-scoped discovery of interactive CHIEF sessions.
//
// ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis
//   Concept: SessionStore.list_sessions — metadata for the caller's sessions
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//
// Not ported: SQLite session storage, channel maps, activity cutoffs, and any
// second persistence system. The checkpoint store remains the only session
// record. Transcript text stays on GET /api/chief/history (möbius
// get_session_history, Phase 17). Hermes session_search is not this read.
// A scheduled session (context.origin === "schedule") is not a conversation.

const PUBLIC_KEYS = ["sessionId", "title", "createdAt", "updatedAt"];

function sessionTitle(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isoTimestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sessionContext(row) {
  const context = row?.context ?? row?.checkpoint?.context ?? null;
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  return context;
}

export function isScheduledSession(row) {
  return sessionContext(row)?.origin === "schedule";
}

export function projectInteractiveSessions(rows, { archivedOnly = false } = {}) {
  const sessions = [];
  for (const row of rows ?? []) {
    if (!row?.id) continue;
    if (isScheduledSession(row)) continue;
    const archived = row.status === "ARCHIVED";
    if (archivedOnly ? !archived : archived) continue;
    const session = {
      sessionId: row.id,
      title: sessionTitle(row.title),
      createdAt: isoTimestamp(row.createdAt),
      updatedAt: isoTimestamp(row.updatedAt),
    };
    sessions.push(session);
  }
  sessions.sort((left, right) => {
    const leftTime = left.updatedAt ?? "";
    const rightTime = right.updatedAt ?? "";
    if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1;
    if (left.sessionId === right.sessionId) return 0;
    return left.sessionId < right.sessionId ? -1 : 1;
  });
  return sessions.map((session) => {
    const projected = {};
    for (const key of PUBLIC_KEYS) projected[key] = session[key];
    return projected;
  });
}

// Client-side view model for the CHIEF conversation sidebar.
// Navigation only. Search hits come from the owner-scoped session-search route.
// This module does not call conversation_retrieve or send a user id.

export const SIDEBAR_COLLAPSED_KEY = "chief.sidebarCollapsed";

export function sidebarSearchPath(query) {
  const params = new URLSearchParams();
  params.set("q", typeof query === "string" ? query : "");
  return `/api/chief/session-search?${params.toString()}`;
}

export function readSidebarCollapsed(storage) {
  try {
    return storage?.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(storage, collapsed) {
  try {
    storage?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Private browsing can reject storage. The open tab still works.
  }
}

export function partitionSidebarConversations({
  sessions = [],
  archivedSessions = [],
  query = "",
  searchResults = [],
} = {}) {
  const activeQuery = typeof query === "string" ? query.trim() : "";
  if (!activeQuery) {
    const recent = Array.isArray(sessions) ? sessions : [];
    const archived = Array.isArray(archivedSessions) ? archivedSessions : [];
    return {
      searching: false,
      recent,
      archived,
      emptyLabel: recent.length === 0 && archived.length === 0 ? "No conversations yet." : "",
    };
  }
  const recent = [];
  const archived = [];
  for (const session of Array.isArray(searchResults) ? searchResults : []) {
    if (!session?.sessionId) continue;
    if (session.archived) archived.push(session);
    else recent.push(session);
  }
  return {
    searching: true,
    recent,
    archived,
    emptyLabel: recent.length === 0 && archived.length === 0 ? "No conversations found" : "",
  };
}

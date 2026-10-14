// Wire body for the settings copy action.
//
// The server only treats a post as a handoff when action is "handoff".
// Selections carry ids and the server-issued content hashes. Excerpt text
// and a caller user id are not part of this body.

export function contextShareHandoffBody({
  query,
  destination,
  confirm,
  querySeal,
  selections,
} = {}) {
  return {
    action: "handoff",
    query,
    destination,
    confirm: confirm === true,
    querySeal,
    selections: (Array.isArray(selections) ? selections : [])
      .filter((item) => item && typeof item.id === "string")
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        contentHash: typeof item.contentHash === "string" ? item.contentHash : "",
      })),
  };
}

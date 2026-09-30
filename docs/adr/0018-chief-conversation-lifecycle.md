# ADR-0018: A caller can discover their interactive conversations

- Status: proposed with the conversation-lifecycle slice
- Date: 2026-09-30
- Scope: `server/chief/runtime/sessions.js`, `server/chief/runtime/checkpoint.js`
  (`listOwnedSessions` only), `api/chief/sessions.js`

## Context

Phase 17 (`GET /api/chief/history?session_id=`) returns one interactive
transcript when the caller already knows the session id. `POST /api/chief/chat`
creates a session when `session_id` is omitted and resumes one when it is
supplied. Nothing listed the caller's conversations, so a later JARVIS client
could not offer "my conversations" without inventing its own registry.

## Reuse check (mandatory)

- OpenJarvis `SessionStore.list_sessions` (`5e5f5ef`) is the concept adapted
  here: return metadata for the caller's sessions. The SQLite session store,
  channel maps, and activity cutoffs are not ported. CHIEF already has
  `ChiefSession` (`id`, `title`, `createdAt`, `updatedAt`, `contextJson`).
- möbius `get_session_history` stays Phase 17. This slice does not add another
  history read or another transcript table.
- Hermes session browsing is the product reference for separate conversations
  and titles. `session_search`, FTS5, the Hermes session database, channels,
  gateway, compression, and subagents are not ported.
- No new persistence system. Listing reads the existing checkpoint store
  through `withUserContext`, the same ownership boundary as `store.load`.

## Decision

1. `GET /api/chief/sessions` returns `{ sessions: [{ sessionId, title, createdAt, updatedAt }] }`
   for the authenticated user. Order is `updatedAt` descending, then
   `sessionId` ascending.
2. `title` is the existing `ChiefSession.title`. It is null when unset. This
   slice does not generate titles and does not add a title store.
3. A session whose context `origin` is `schedule` is omitted. That is the same
   distinction Phase 17 uses. The list does not decrypt checkpoints, so a
   scheduled prompt never enters the response.
4. The response does not include transcript text, checkpoint fields, taint,
   approval state, ciphertext, user ids, or scheduler ids.
5. Starting a conversation remains `POST /api/chief/chat` without `session_id`.
   Opening and continuing remain Phase 17 history plus chat with that
   `session_id`. There is no second resume path and no new-session endpoint.

## Consequences

- A future JARVIS client can list, open, and continue conversations without a
  client-owned session registry.
- Search, pagination, AI titles, deletion, and the JARVIS UI stay out of this
  slice.
- Phase 17 history, the turn machine, approvals, and the scheduler are
  unchanged aside from the read method on the existing store.

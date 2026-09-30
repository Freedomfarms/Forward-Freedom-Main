# ADR-0017: A caller can read one owned interactive transcript

- Status: proposed with Phase 17
- Date: 2026-09-30
- Scope: `server/chief/runtime/history.js`, `api/chief/history.js`

## Context

`POST /api/chief/chat` returns `session_id`, and `TurnMachine` reloads that
checkpoint on the next message. The transcript stays in the checkpoint. Nothing
returned it to the caller. `session_history` exists as a wire name and is not
emitted. A later client that stored its own copy would be a second transcript.

## Reuse check (mandatory)

- möbius `get_session_history` (`crates/mobius-gateway/src/server/dispatch.rs`,
  `3e1aaf5`) returns one selected session's history page. CHIEF adapts that
  contract: one caller-owned session id in, the interactive transcript out.
  The gateway, session runtime, terminal, and command catalog are not ported.
- `routine_run_preview` returns a routine's execution session. It is not used.
  `schedule_outcome` remains the scheduled-run read.
- Hermes `session_search` is not ported. There is no cross-session search.
- OpenJarvis `SessionStore.list_sessions` is not this read. Listing sessions
  is a later choice.

## Decision

1. `GET /api/chief/history?session_id=` loads through the existing checkpoint
   store and returns `{ sessionId, messages: [{ role, text }] }`.
2. `store.load` is scoped by the authenticated user. A missing id and another
   user's id both answer `session not found`.
3. `context.origin === "schedule"` is not interactive history. The handler
   answers `session not found` and does not return the scheduled transcript,
   task id, run id, or operator state.
4. Message text is `messageText` of the stored transcript entry. `user`,
   `assistant`, and `tool` roles are kept. Other checkpoint fields are not
   returned. Fenced text is withheld as `text: null`.
5. The handler only calls `load`. It does not construct `TurnMachine`, call
   `runChiefTick`, or write the checkpoint. No approval and no new capability
   are required. This is not a tool call, matching `GET /api/chief/approvals`.

## Consequences

- The checkpoint remains the only transcript source.
- Session listing, the JARVIS interface, and persona writes stay out of this
  slice.
- Resume, approval resume, the scheduler, and the Phase 16 baseline are
  unchanged.

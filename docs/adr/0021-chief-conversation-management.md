# ADR-0021: Manage a CHIEF conversation on ChiefSession

- Status: proposed with the conversation-management slice
- Date: 2026-10-01

## Decision

1. `ChiefSession` stays the only CHIEF conversation record. CEO Agent
   `AgentConversation` rows are a different system and are not read or deleted
   here. There is no second transcript store and no conversation tool.
2. `GET /api/chief/sessions` keeps the ADR-0018 shape and omits archived and
   scheduled sessions. `GET /api/chief/sessions?archived=1` returns the same
   shape for archived interactive sessions. Scheduled sessions stay out of both.
3. Archive is `ChiefSession.archivedAt`. `status` stays the runtime state
   because `saveWithEvents` rewrites it. Archive keeps the checkpoint. Chat on
   an archived session returns 409 until it is restored. History can still be
   read. Delete is a separate hard delete of that session, its checkpoint
   journals, and its `ChiefApproval` rows, and it requires `confirm: true`.
   Traces, financial data, and other sessions stay.
4. A title is written once, from the first user message, after an assistant
   reply, and only while `title` is null. It is not a model call. Messages that
   contain amounts, account numbers, or secrets are left untitled. A later
   rename is kept.
5. Every mutation loads the session with the authenticated user id. A user id
   in the body is ignored. Another user's session id is a 404.

## Consequences

Conversation tools and cross-conversation recall stay out of this slice. The
access sheet does not invent a Read, Organize, or Delete grant. Ownership is
the signed-in user.

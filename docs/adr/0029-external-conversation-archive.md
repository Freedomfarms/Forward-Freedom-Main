# ADR-0029: External conversation archive for historical imports

- Status: accepted for Phase 1
- Date: 2026-10-13
- Scope: `server/chief/archive/`, `api/chief/external-conversations.js`, `external_conversation`, `external_message`

## Decision

1. Claude and ChatGPT exports land in `external_conversation` and `external_message`. They are not `ChiefSession` rows and they do not create checkpoints.
2. Message bodies and titles use the existing envelope encryption (`encryptJson`). `recallDocument` is a redacted plaintext projection, capped, for a later search phase. It is not injected into a CHIEF prompt by this slice.
3. Ownership is the authenticated user. New tables use `FORCE ROW LEVEL SECURITY` and `user_isolation`. Provider and role are Postgres enums matching the Prisma schema. The migration grants DML to `freedom_app` and `freedom_service` when those roles exist. Import and delete write `chief_audit_log` with counts only.
4. Reimport matches `(userId, provider, externalId)`. The same content hash is a duplicate. A changed hash replaces that conversation's messages. A conversation missing from a later file is left in place.
5. When an export has no provider conversation id, the id is `derived:` plus a hash of the provider, title, and every message. The same export therefore reimports as a duplicate, and a transcript that differs anywhere becomes a separate row. Provider message ids are kept. A missing message id is `ordinal:` plus a hash. A repeated message id is kept with a `#index` suffix.
6. The ChatGPT visible thread is the `current_node` parent walk. Other regenerated branches are counted in `omittedBranchCount` and are not merged into the transcript.
7. Uploads are JSON or ZIP, at most 3 MB decoded, and ZIP expansion stops at 12 MB. `users.json` and other account files are not read.

## Later phases, not this slice

- Phase 2: search CHIEF, Claude, and ChatGPT with source attribution. `recallDocument` and its GIN index exist so that phase does not need a new transcript table.
- Phase 3: durable facts through the existing `ChiefFact` path. This slice does not extract facts.
- Phase 4: user-controlled live capture.
- Phase 5: authorized retrieval for native Claude and ChatGPT integrations.
- Phase 6: capture health, reindexing, and memory maintenance.

## Consequences

Imported transcripts are untrusted data. This slice has no tool, no system-prompt write, and no provider call. The upload ceiling is the serverless body limit, so a full multi-year export may need to be split before it can be imported.

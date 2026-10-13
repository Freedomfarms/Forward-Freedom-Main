# ADR-0030: Derived conversation memory on ChiefFact

- Status: accepted for Phase 3
- Date: 2026-10-13
- Scope: `server/chief/memory/`, `server/chief/archive/`, `server/chief/context/`, `api/chief/external-conversations.js`

## Context

Phase 1 stores Claude and ChatGPT transcripts in the encrypted archive. Phase 2 searches that archive with native CHIEF recall. `ChiefFact` is already the personal-memory store (ADR-0028): encrypted content, dedupe by normalized text, trust tier, and a per-user cap. `source` is text. The embedding column stays unused.

The existing rules say what automatic extraction may keep, and they say a tool cannot promote a fact to TRUSTED. They do not say how a sentence from an imported transcript becomes a durable note, or what to do when a later sentence conflicts with one.

## Decision

1. No new table, fact store, vector index, or memory provider. Derived notes are `ChiefFact` rows. The archive and the CHIEF transcript remain the source of truth.
2. Provenance lives in `source`: `derived:v1`, provider (`chief`, `claude`, or `chatgpt`), encoded conversation id, encoded message id, kind, encoded external id, and the observation time. Kinds are `preference`, `decision`, `temporary`, and `unverified`.
3. Derivation does not run on import, search, or every turn. The archive screen action "Keep durable notes", or a confirmed `memory_write` that names both `provider` and `session_id`, reads the owned stored transcript. Model-supplied content is ignored on that path. A missing or unowned conversation stores nothing.
4. Only a user sentence can qualify. Assistant and tool text cannot. One qualifying sentence per user message, at most eight. Injection-fenced sentences are dropped. Sentences that state health, religion, race, ethnicity, sexual orientation, or political affiliation are skipped and are not inferred. Secrets and volatile snapshots still fail `qualifiesForLongTermMemory`.
5. Uncertain language is `UNTRUSTED` and is not injected as durable knowledge. Temporary language expires after 14 days. Preferences and decisions are `AUTO`. A duplicate normalized sentence returns the existing row and does not change its trust or text. A newer overlapping or contradictory sentence is a new `UNTRUSTED` row. It does not overwrite the earlier fact.
6. Deleting an imported conversation, or a native CHIEF conversation, deletes derived rows whose provenance points at that conversation. Other facts and other owners stay. Expired temporary rows leave recall through the existing `expiresAt` check.
7. Recall still uses `selectPersonalFacts`, `rankEpisodes`, and the context token budget. Standing preferences include provenance kind `preference` when the row is not `UNTRUSTED`. Archive `recallDocument` rows join the same episode ranking and stay capped at three snippets. Unverified rows may appear only as a short labeled uncertainty section when they lexically match the request. Prompts do not receive the archive.
8. Imported transcripts stay untrusted historical content. Remembered notes and archived excerpts are context. They are not instructions and they do not grant tools.

## Consequences

A person can inspect and remove derived notes on the imported-conversation screen. `memory_read` still lists facts and includes parsed provenance when the source is a derived note. Live database RLS is unchanged from the existing `chief_fact` policy and is not re-proven by this slice. Phase 4 live capture, MCP, and cross-model context injection stay out of scope.

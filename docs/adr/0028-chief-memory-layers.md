# ADR-0028: Three memory layers on the stores CHIEF already has

- Status: proposed
- Date: 2026-10-05
- Scope: `server/chief/memory/`, `server/chief/context/assemble.js`, `server/chief/context/wire.js`

## Context

CHIEF already keeps the open transcript in the checkpoint, compacts it, stores personal facts in `chief_fact`, and searches past conversations through `ChiefSession.recallDocument`. Traces record turns for a later learning pass. A JARVIS-style assistant needs those pieces to behave as working, personal, and episodic memory without a second database or a second learning system.

## Reuse check (mandatory)

- OpenJarvis `inject_context`, FactStore trust tiers, extraction, and reciprocal rank fusion stay the personal-memory path (ADR-0006). Hybrid pgvector search is not turned on: fact bodies are encrypted, and the existing `embedding` columns remain unused by Prisma.
- möbius compaction and `compaction.handoff` stay the working-transcript bound. The new working projection is derived from that transcript. It does not replace it.
- Conversation recall (ADR-0017, ADR-0018, ADR-0021) stays the episodic source. `listRecallDocuments` is a read of `recallDocument`. `conversation_search` ranking is unchanged.
- `ChiefTrace` stays the learning substrate (ADR-0009). This slice does not read or write traces.
- isair/jarvis rolling conversation context and PersonalJarvis "do not wiki every turn" are the patterns adapted. Their desktop stores, voice stacks, and wiki vaults are not ported.
- BUILD NEW: the qualification gate, the layer planner, and the in-process token embedding. No audited CHIEF module decided whether a fact was durable, which layer a request needed, or ranked recall documents by meaning. Postgres already holds the rows.

## Decision

1. Working memory is `buildWorkingMemory` over the checkpoint transcript and handoff notes. It keeps a token-bounded tail, active entities, the current request, recent tool excerpts, and the referent for "it" / "that".
2. Personal memory remains `chief_fact`. Automatic extraction drops volatile balances, prices, secrets, and empty chatter. "Remember that…" and "Forget that…" write or delete through the fact store. Dedupe, the fact cap, trust tiers, and `memory_write` approval are unchanged.
3. Injection uses `selectPersonalFacts`. Unrelated facts are left out. Standing `preference` facts may still enter. On a live finance, web, or code question, quantity snapshots are left out. The system prompt says current tool results override memory.
4. Episodic memory ranks owned `recallDocument` rows with the local embedding, the existing lexical rank, recency, and importance. Retrieval runs only when the request refers to a past episode. The current session is excluded. Another user's rows are excluded.
5. No new table and no new memory service.

## Consequences

Freedom Financial readers, web search, traces, the scheduler, approvals, and the conversation APIs stay as they are. A provider embedding can later replace `embedText` and fill the existing pgvector columns. Trace feedback learning stays deferred.

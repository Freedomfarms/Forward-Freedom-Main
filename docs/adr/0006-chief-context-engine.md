# ADR-0006: CHIEF context is the ported OpenJarvis and möbius machinery

- Status: proposed with Phase 6
- Date: 2026-09-30

## Decision

1. Context assembly is OpenJarvis `inject_context` (`src/openjarvis/tools/storage/context.py`):
   `ContextConfig`, whitespace token counts, fail-closed trust filtering, half-budget
   when documents exist, system message merged to the front. The system message is
   built per model call and is not written into the transcript or the checkpoint.
2. Fact order uses OpenJarvis `reciprocal_rank_fusion` over a keyword ranking and a
   recency ranking. `HybridMemory` is not ported: facts are encrypted, so there is no
   sparse/dense document backend to fuse. `factPriority: "given"` is the one addition
   to `inject_context`, so that fused order is not reversed back to newest-first.
3. Extraction is OpenJarvis `FactExtractor` plus `MemoryService._process`: same prompt,
   parse, caps, exchange-level HIGH/CRITICAL block, per-fact quarantine, scanner
   fail-open, never-throws. The model call is `ChiefModelEngine.generate` with caller
   kind `event`, so the budget cap and the pause flag apply. Storage is the existing
   fact store. There is no background thread.
4. Compaction is möbius `recent_cut` / `prepare_summary` / the checkpoint prompt, with
   tool results truncated at 2,000 characters. The summary call goes through
   `ChiefModelEngine`. Trigger and keep-recent constants are scaled
   (`CHIEF_COMPACTION_TOKENS` 6,000, `CHIEF_KEEP_RECENT_TOKENS` 1,500) because CHIEF
   estimates tokens by whitespace and runs in a serverless invocation; the möbius
   250,000 / 20,000 defaults are kept as named constants. `new_context` and the
   urgent/reset tool lockdown are not ported: that ladder is a second control loop.
5. Handoff notes use möbius key `compaction.handoff`, the 21,000-byte cap, and the
   restored-notes wording. `write_handoff` is a confirmed `MEMORY_WRITE` tool.
   Automatic compaction also stores its summary under that key.
6. Identity follows the Hermes identity slot (persona, else a default). Hermes reads
   `SOUL.md`. CHIEF stores the persona as a `TRUSTED` fact with source `identity` in
   the existing fact store. A fenced persona is refused. Hermes warns and still loads
   a user-authored file; CHIEF does not, because the text becomes the system message.

## Consequences

Recalled facts are reference data. Untrusted and unknown tiers never enter the prompt.
Extraction cannot mark a fact `TRUSTED` and will not downgrade an identity fact.
Skills, embeddings, and the OpenJarvis sidecar are not part of this slice.

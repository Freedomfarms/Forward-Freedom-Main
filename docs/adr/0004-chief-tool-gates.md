# ADR-0004: CHIEF tool gates stay under the provider

- Status: accepted with Phase 4
- Date: 2026-09-29
- Scope: `server/chief/tools`, `server/chief/security`, turn mutation classification

## Decision

1. Grok remains the default language model through the existing `xai` descriptor.
   Phase 4 does not add a provider, and it does not import `@ai-sdk/xai` outside
   `server/chief/models/providers.js`.
2. Hermes is not integrated. `AIAgent.run_conversation` is not placed above the turn.
   A later Hermes model would be another `languageModel()` descriptor. A later skill
   would be a `ToolSpec` executed only by `ToolExecutor`.
3. `ToolExecutor` is the only execution path. Gates are mandatory and fail-closed.
   Upstream skips a missing limiter, guard, or policy; CHIEF refuses the call.
4. Confirmation reads the grant `ApprovalCoordinator` already recorded. There is no
   second approval store and no `confirm_callback`.
5. `requiresConfirmation` is the mutation bit. Read tools are not submitted as mutations.
6. Session taint is stored on the checkpoint.
7. The boundary guard blocks every non-local tool. The OpenJarvis secret/PII scanners
   are Rust-only and are not ported here. An empty scanner list is not a completed gate.
8. Output fencing runs on the non-local result after the timed call returns and before
   the result is released. The scan gate is still required before execution: if it is
   missing, the call does not run. A scanner exception returns an error and drops the
   raw text.
9. Timeout aborts an `AbortSignal` and stops waiting. It does not claim the underlying
   operation was cancelled when the tool ignores the signal.
10. `schedule_create` records a row and does not dispatch it. No scheduler, cron, or
    autonomous loop is added. `caller.kind === "schedule"` uses the same gates.
11. Code-execution tool names and `code:execute` are rejected at registration.

## Consequences

Hybrid retrieval, fact extraction, and knowledge-graph consolidation remain later work.
MCP cannot make a network call until scanner patterns are ported and block mode is
replaced on purpose. Rate-limit buckets are per user inside the process store; a new
serverless instance starts with empty buckets.

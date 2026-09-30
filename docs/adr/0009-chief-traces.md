# ADR-0009: A CHIEF trace records a turn that already ran

- Status: proposed with Phase 9
- Date: 2026-09-30

## Decision

1. `TraceCollector` subscribes to the turn's existing event bus for
   `inference_start`, `inference_end`, `tool_call_start`, `tool_call_end`,
   and `memory_retrieve`. It appends `RESPOND` when `TurnMachine.run`
   returns, saves once, and publishes `trace_complete`. It does not wrap
   an agent and does not call `run()` on anything.
2. Rows are `ChiefTrace` and `ChiefTraceStep`, written through
   `withUserContext`. There is no SQLite file, no FTS index, and no new
   query, result, or messages column. `feedback` stays null.
3. Step detail is an allowlist: model, provider, engine, token counts,
   retrieval counts, tool name, and success. User text, answers, tool
   arguments, and tool outputs are not stored. `ROUTE` is taken from
   `inference_start`. OpenJarvis defines that step type and its collector
   does not emit it.
4. A `capability_denied` event is recorded as a failed `TOOL_CALL`. The
   tool body is not retried. Confirmation still suspends in
   `ApprovalCoordinator` before execution. `finance:read` is unchanged.
5. A store error is logged and dropped. A turn error still propagates.
   `LearnedRouterPolicy` is not activated.

## Consequences

The heuristic router is unchanged. Checkpoint `fork()` is unchanged and
unused by tracing. The scheduler still claims the same tasks and runs one
`TurnMachine` per task. Sidecar, Command Center, subagents, and feedback
learning stay deferred.

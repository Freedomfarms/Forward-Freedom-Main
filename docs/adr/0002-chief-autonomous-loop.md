# ADR-0002: Controlled autonomous operation is a future CHIEF capability

- Status: proposed (recorded during Phase 2; the loop is not implemented)
- Date: 2026-09-29
- Scope: CHIEF (Module 03). Governing text: [CHIEF_ARCHITECTURE.md](../CHIEF_ARCHITECTURE.md) §5.5.

## Context

CHIEF has to be able to operate without a person prompting every step: wake on a schedule,
react to an event, notice that something changed, and either act, ask, or stay quiet. That
requirement showed up after the Phase 2 model layer landed. The risk is a second, prompt-less
control loop that bypasses the router, the capability policy, the approval gate, and the
event journal. This ADR records the constraint those later phases must build inside.

## Reuse check (mandatory)

- **REUSE / PORT, do not invent.** The loop's trigger and tick model is the audited
  OpenJarvis scheduler and operative (commit `5e5f5ef`):
  - `src/openjarvis/scheduler/` — task kinds once / interval / cron, run log, retries.
    Already the source for `ChiefScheduledTask` / `ChiefTaskRun` and Phase 5.
  - `src/openjarvis/agents/operative.py` — state key `operator:{id}:state`, tick execution,
    auto-persist of results.
  - `src/openjarvis/agents/executor.py` `execute_tick` — concurrency lock, rolling summary,
    and the per-agent `router_policy` that calls `build_routing_context(instruction)` then
    `policy.select_model`. A tick routes on an **instruction**, not on a chat message.
  - möbius (`3e1aaf5`) — approval suspension, interrupt, fresh conversation per routine run.
- No new scheduler, event bus, approval store, or router is introduced. jarvis-architecture
  remains REFERENCE ONLY (no license).
- **Phase 2 code that keeps the path open** (this is the whole of the implementation):
  - `resolve(query)` / `generate(messages, { query })` route on whatever string the caller
    supplies. An operative instruction is a valid query.
  - Per-call `model` and `routerPolicy` match the per-agent override in `execute_tick`.
  - Optional `caller` `{ kind: user_turn | schedule | event | delegation, id, trigger }` is
    copied onto `INFERENCE_START` / `INFERENCE_END`. Absent caller leaves the upstream
    payload unchanged. This is correlation for the existing EventBus, trace collector, and
    Constellation bridge — not a new event system.
  - `CHIEF_MODELS_ENABLED=false` makes `resolve`, `generate`, and `languageModel` throw
    `ModelLayerPausedError`, for every caller.
  - `languageModelMiddleware` stays the single place budget enforcement can wrap every
    model, so a future tick cannot outspend a user turn by calling a provider directly.

## Decision

1. The autonomous operating loop in §5.5 is a committed future capability. It is assembled
   from the scheduler (Phase 5), the operative tick (Phase 5), memory (Phase 4), the tool
   and approval gates (Phases 3–4), and this model layer. Phases implement their own piece
   of that loop; none of them adds a parallel one.
2. A proactive run is held to the same rules as an interactive turn: permissioned,
   auditable, interruptible, rate- and budget-limited, traceable, pauseable, and subject to
   capability and approval policy. "Nothing warrants attention" is a successful outcome and
   does not notify anyone.
3. Phase 2 does not implement triggers, perception, tick state, delegation, or notifications.
   It only keeps the model contract caller-agnostic, as specified above.

## Consequences

- Later phases that need a model call from a cron tick or an event handler use
  `createModelEngine` and pass `caller`. They do not construct `@ai-sdk/*` providers.
- The Constellation visualizes autonomous activity only by consuming the same event stream
  (§7.4). No second scene path.
- `ChiefBudget` is still not enforced (ADR-0001). It has to be enforced at the middleware
  seam before autonomy levels 3–4 are enabled (§10). The pause flag is the kill switch
  until then.
- Tests: `test/chief-model-engine.test.js` covers instruction-only routing, caller
  propagation, caller rejection, and the pause flag.

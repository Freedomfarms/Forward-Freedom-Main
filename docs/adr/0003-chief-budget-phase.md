# ADR-0003: ChiefBudget stays a model-layer check and lands in Phase 3

- Status: accepted
- Date: 2026-09-29
- Scope: CHIEF (Module 03) phase ledger. [CHIEF_ARCHITECTURE.md](../CHIEF_ARCHITECTURE.md) §9 and §10.

## Context

§9 originally listed budget-cap checks (`ChiefBudget`) under Phase 2, next to the provider
registry and the router. The approved Phase 2 scope did not include them, and the Phase 2
report deferred them. That deferral was not a decision to drop the requirement or to move it
to Phase 8. This ADR is the Phase 2 → Phase 3 ledger correction.

## Reuse check (mandatory)

- The `chief_budget` table (Phase 1) is CHIEF's own schema. The cap idea is REFERENCE ONLY
  from jarvis-architecture (no license); no code is taken from it.
- OpenJarvis publishes `AGENT_BUDGET_EXCEEDED` on the event bus when a managed agent passes
  its budget. CHIEF keeps that event type (Phase 1 taxonomy) and performs the check in the
  model engine, which every caller shares.
- No new budget framework. The check reads and increments `ChiefBudget` rows.

## Decision

1. The requirement is preserved: per-scope, per-period USD caps, enforced before a provider
   call, fail-closed when a configured cap would be exceeded.
2. The architectural home stays the model layer (`server/chief/models`), on both `generate`
   and `openStream` (`streamText`). It does not move into the turn machine. The turn machine
   is one caller. A future scheduled tick is another. Both must hit the same check.
3. The phase moves from Phase 2 to Phase 3, and no further. Phase 2 had no caller that spent
   money, because the approved scope stopped at routing. Phase 3 is the first phase that
   calls a model, so the check has to exist before `streamText`. Phase 8 remains the
   budget-enforcement UX, not the check itself.
4. A missing `chief_budget` row means no cap is configured for that scope (development and
   uncapped accounts keep working). A row that would be exceeded refuses the call with
   `BudgetExceededError` before the provider is contacted. Spend is recorded after a call
   that was allowed. Calendar periods (`day`, `month`) reset `spentUsd` when `periodStart`
   falls outside the current window. `run` does not reset on a calendar boundary.
5. This ADR does not enable autonomy levels 3–4. Those stay off until they are built on top
   of this same check.

## Consequences

- Phase 3 implements `server/chief/models/budget.js` and calls it from `ChiefModelEngine`
  on both `generate` and `openStream`.
- When a bus is attached, the engine publishes `AGENT_BUDGET_EXCEEDED` and then throws
  `BudgetExceededError`. The turn machine maps that error to a protocol `error`
  (`budget_exceeded`) and aborts. It does not keep its own cap arithmetic. A missing bus
  does not skip the refusal; the protocol error is the client signal.
- Tests cover the under-cap call, the pre-call refusal, period reset, and the absence of a
  row.

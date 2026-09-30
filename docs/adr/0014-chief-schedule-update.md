# ADR-0014: A scheduled task's definition can be edited in place

- Status: proposed with Phase 14
- Date: 2026-09-30
- Scope: `server/chief/tools/schedule-store.js`, `server/chief/tools/builtin.js`,
  `server/chief/tools/inventory.js`

## Context

`schedule_create` inserts a new row. Pause, resume, cancel, and the run ledger
operate on that row. Changing the name, prompt, or cadence required cancel plus
create, which allocated a new id and split the run history from the task that
will fire next.

## Reuse check (mandatory)

- Hermes `tools/cronjob_tools.py` `_update_core_fields` and the schedule branch
  of `_update_run_fields` (`8c30ef3`) edit prompt, name, and schedule without
  firing the job. A paused job stays paused. CHIEF uses that shape.
- `deliver`, script, skills, model pins, and `_action_run` are not ported.
- OpenJarvis `SchedulerStore.update_task` replaces the whole row. It is not used.
- Validation stays `normalizeSchedule`. `initialNextRun` is the existing next-run
  function. No new scheduler is added.

## Decision

1. `schedule_update` is a confirming local tool. It uses `schedule:create` and
   `withUserContext`. Another user's task id is not found.
2. The editable fields are name, prompt, kind, `cronExpr`, `intervalSeconds`,
   `runAt`, and timezone. Omitted fields keep the stored definition. The merged
   definition is passed through `normalizeSchedule`.
3. `ACTIVE` and `PAUSED` may be updated. `COMPLETED` and `CANCELLED` may not.
   The tool does not change status, id, or `agentId`.
4. A row with `lockedAt` set, or with one of the caller's runs in
   `AWAITING_APPROVAL`, is not written.
5. An `ACTIVE` update sets `nextRunAt` from `initialNextRun`. A `PAUSED` update
   leaves `nextRunAt` unchanged so `schedule_resume` still computes it.
6. The tool does not call the tick, construct a `TurnMachine`, decrypt a run
   result, or send anything.

## Consequences

- Run rows stay on the same `scheduledTaskId`.
- `quietAttention()` stays false. The tick, Phase 11 resume, and the Phase 12
  and Phase 13 tools are unchanged.

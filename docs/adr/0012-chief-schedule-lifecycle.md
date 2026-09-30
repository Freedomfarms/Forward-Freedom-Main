# ADR-0012: Scheduled tasks can be listed, paused, resumed, and cancelled

- Status: proposed with Phase 12
- Date: 2026-09-30
- Scope: `server/chief/tools/schedule-store.js`, `server/chief/tools/builtin.js`,
  `server/chief/tools/inventory.js`

## Context

`schedule_create` can add a `ChiefScheduledTask`. After Phase 11 a one-time
task can sit `ACTIVE` while its run waits on approval, and the tick will not
resume that run. `CANCELLED` already exists on the task status enum and nothing
sets it. The signed-in user has no governed way to list, pause, resume, or
cancel a task.

## Reuse check (mandatory)

- OpenJarvis `src/openjarvis/scheduler/tools.py` and `TaskScheduler` in
  `scheduler.py` (`5e5f5ef`) already split list, pause, resume, and cancel.
  Pause sets paused. Resume sets active and recomputes the next time. Cancel
  sets cancelled, clears the next time, and keeps the row. The polling thread,
  `system.ask`, and the per-task `agent` / `tools` fields are not ported.
- Hermes `cron/jobs.py` `pause_job` / `is_job_runnable` (`8c30ef3`): a pause
  affects later fires only. CHIEF already claims only `ACTIVE` rows.
  `resume_job` catch-up of an elapsed slot, `trigger_job`, and the process-wide
  estop are not ported. Resume uses `initialNextRun` from now.
- möbius `delete_routine` refuses a run that is still `Running`. CHIEF does not
  delete the row. Pause and cancel do not abort a `TurnMachine` that is already
  running or waiting on approval. Phase 11 resume is unchanged.
- No new scheduler, executor, approval store, or capability label. The four
  tools use the existing `schedule:create` grant.

## Decision

1. `schedule_list` is a local read. It does not require confirmation. It
   returns only the caller's tasks: id, name, kind, status, `nextRunAt`,
   `lastRunAt`, and whether one of that user's runs is `AWAITING_APPROVAL`.
   It does not return prompts, run results, or operator state.
2. `schedule_pause`, `schedule_resume`, and `schedule_cancel` require
   confirmation. A scheduled caller has no sticky approval, so those calls
   suspend until the signed-in user decides.
3. Pause moves `ACTIVE` to `PAUSED` and does not change `nextRunAt` or
   `lockedAt`. Pausing an already paused task returns the current row and does
   not write again. `COMPLETED` and `CANCELLED` cannot be paused.
4. Resume moves only `PAUSED` to `ACTIVE` and sets `nextRunAt` with
   `initialNextRun`. It does not call the tick or `TurnMachine`. A one-time
   `runAt` that is already past becomes due on the next tick. `COMPLETED` and
   `CANCELLED` cannot be resumed.
5. Cancel moves `ACTIVE` or `PAUSED` to `CANCELLED` and clears `nextRunAt`.
   The row and its runs stay. Cancelling an already cancelled task does not
   write again. `COMPLETED` cannot be cancelled. An in-flight or
   `AWAITING_APPROVAL` run is not aborted.
6. Every read and write is scoped by `userId`. Another user's task id is not
   found. Prisma writes go through `withUserContext`.

## Consequences

- The tick is unchanged. A paused or cancelled task is not claimed because it
  is not `ACTIVE`.
- Phase 11 still finishes an awaiting run if the user later approves it. Cancel
  does not invalidate that session. For a non-once task, that finish does not
  change `CANCELLED`. A one-time task can still become `COMPLETED` when that
  frozen finish treats the outcome as terminal.
- `quietAttention()` stays false. These tools send nothing.
- `schedule_create` and the `user_private` sink are unchanged.

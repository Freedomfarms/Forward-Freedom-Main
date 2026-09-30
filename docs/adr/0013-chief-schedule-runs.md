# ADR-0013: Scheduled runs can be listed without delivering them

- Status: proposed with Phase 13
- Date: 2026-09-30
- Scope: `server/chief/tools/schedule-store.js`, `server/chief/tools/builtin.js`,
  `server/chief/tools/inventory.js`

## Context

Phase 12 can list, pause, resume, and cancel a task. The tick records a
`ChiefTaskRun`. That run's result is encrypted, and `schedule_list` does not
return it. The signed-in user has no governed way to see the run ledger:
which runs exist, their status, and when they started and finished.

ADR-0010 stores `attention: false` and sends nothing. A local lookup is not a
delivery target.

## Reuse check (mandatory)

- OpenJarvis `SchedulerStore.get_run_logs` (`5e5f5ef`) returns the newest run
  rows for a task, capped at 10. `schedule_runs` uses that shape. Upstream
  also returns `result` and `error` text. CHIEF does not.
- OpenJarvis scheduler tools are local tool specs. `schedule_runs` is one more
  spec on the existing executor. The polling thread is not ported.
- Hermes `cron/scheduler_delivery.py` treats a local deliver value as no
  targets, so nothing is sent and the saved run remains available to look up.
  `_deliver_result`, the delivery queue, bot-chat delivery, and session
  seeding are not ported.
- möbius `routine_run_preview` returns the session history page. It is not
  ported.

## Decision

1. `schedule_runs` is a local read. It does not require confirmation. It uses
   the existing `schedule:create` grant. Every read is scoped by `userId`
   through `withUserContext`.
2. The tool returns at most 10 runs, newest `startedAt` first. Each run has
   only `id`, `scheduledTaskId`, `status`, `attempts`, `startedAt`, and
   `completedAt`.
3. An optional `taskId` limits the list to that task. A task the caller does
   not own is not found, the same response as the Phase 12 lifecycle tools.
   Omitting `taskId` lists only the caller's runs.
4. The read does not decrypt `resultCiphertext`. It does not return `error`,
   `summary`, `prompt`, tool output, operator state, `sessionId`, or `userId`.
   Stored statuses are returned as stored, including `AWAITING_APPROVAL`,
   `RUNNING`, `RETRYING`, `SUCCEEDED`, `FAILED`, and `SKIPPED`.
5. The tool does not claim, pause, resume, cancel, or otherwise write a task
   or a run. It does not call the tick or construct a `TurnMachine`. It does
   not deliver, notify, or raise attention.

## Consequences

- `quietAttention()` stays false. There is no notification row and no sender.
- `schedule_create`, the `user_private` sink, the tick, Phase 11 resume, and
  the Phase 12 lifecycle tools are unchanged.
- `schedule_update`, notifications, and `attention: true` stay out of this
  phase.

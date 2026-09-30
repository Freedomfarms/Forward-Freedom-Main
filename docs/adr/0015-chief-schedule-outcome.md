# ADR-0015: One scheduled run's stored outcome can be read

- Status: proposed with Phase 15
- Date: 2026-09-30
- Scope: `server/chief/tools/schedule-store.js`, `server/chief/tools/builtin.js`,
  `server/chief/tools/inventory.js`

## Context

`schedule_runs` lists ledger metadata and does not decrypt `resultCiphertext`.
The tick already stores `result.summary` (1,000 characters) and `ChiefTaskRun.error`.
A later turn could see that a run succeeded or failed, and could not see that
stored conclusion.

## Reuse check (mandatory)

- OpenJarvis `SchedulerStore.get_run_logs` (`5e5f5ef`) returns `result` and
  `error` text on each log row. `getOutcome` uses those two fields for one
  caller-owned run. The list stays metadata-only. The polling thread is not
  ported.
- Hermes `hermes_cli/cron.py` `cron_runs` (`8c30ef3`) prints the recorded
  error line and does not print the output file. `schedule_outcome` returns
  the stored error when the injection scan allows it. `_latest_job_output_excerpt`,
  `_action_run`, the delivery queue, and bot-chat delivery are not ported.
- Hermes local delivery (an empty deliver value has no targets) stays the
  rule behind `quietAttention()`. This read does not change that function.
- möbius `routine_run_preview` returns the session history page. It is not
  ported.

## Decision

1. `schedule_outcome` is a local read. It does not require confirmation. It
   uses `schedule:create` and `withUserContext`. A foreign run id, an unknown
   run id, and a run whose task the caller does not own are not found.
2. The tool returns `id`, `scheduledTaskId`, `status`, `attempts`,
   `startedAt`, `completedAt`, `summary`, and `error`.
3. `summary` is `result.summary` only, capped at 1,000 characters. A missing
   result yields `summary: null`. `AWAITING_APPROVAL`, `RUNNING`, and
   `RETRYING` do not read the result and return `summary: null`.
4. `summary` and `error` pass `scanInjection`. A fenced summary fails the
   tool with a fixed message and is not released. A fenced error is returned
   as null. The raw decrypted object, `sessionId`, prompt, tool output,
   operator state, token counts, `attention`, and `resultCiphertext` are not
   returned.
5. A non-empty summary sets session taint `user_private`. The tool does not
   write, claim, tick, resume, notify, or construct a `TurnMachine`.

## Consequences

- `schedule_runs` still returns six ledger fields.
- `quietAttention()` stays false. `tick.js`, `resume.js`, `turn.js`, and
  `ApprovalCoordinator` are unchanged.

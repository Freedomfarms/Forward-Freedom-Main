# ADR-0011: A scheduled approval resumes the same session

- Status: proposed with Phase 11
- Date: 2026-09-30
- Scope: `server/chief/scheduler/resume.js`, `server/chief/scheduler/store.js`,
  `server/chief/scheduler/tick.js`, `api/chief/approvals.js`, `api/chief/chat.js`

## Context

ADR-0005 runs a scheduled task as one TurnMachine session with caller kind
`schedule`. A confirming tool suspends that turn and records
`ChiefTaskRun` `AWAITING_APPROVAL`. Phase 5 left the resume as a `user_turn`
that did not finish the run, and the approvals route built an empty
`ToolExecutor`. A ONCE task was also marked `COMPLETED` on that first
suspension. The scheduled run could not finish on the session that started it.

## Reuse check (mandatory)

- möbius `observe_routine_event` (`3e1aaf5`,
  `crates/mobius-gateway/src/host/session/events.rs`) does not finish a routine
  on `ExecApprovalRequest`. `TurnComplete` and `TurnAborted` do. `resume_pending`
  and `resolve_tool_approval` continue the same session. CHIEF keeps that rule.
  The möbius runtime and approval types are not copied.
- OpenJarvis `scheduler.py` `system.ask` blocks the scheduler thread.
  `approval_routes.py` only flips a status. `ProactiveAgent` queues actions and
  calls `channel_send`. `execute_tick` `confirm_callback` can auto-approve.
  None of those are used.
- Hermes `cron_mode` approve/deny (`8c30ef3`) is not used. CHIEF already chose
  suspend-and-wait (ADR-0005). There is no cron approval mode, no auto-approval,
  and no auto-denial.
- No new approval store. `ApprovalCoordinator` remains the approval authority.

## Decision

1. The scheduled approval resume is a continuation of the existing scheduled
   session. The HTTP request is the signed-in user. The session context stays
   `callerKind: "schedule"` and `trigger: "schedule:<taskId>"`. It is not
   converted into a `user_turn`.
2. `AWAITING_APPROVAL` is not a terminal outcome. The cron tick does not claim
   or resume that run, and it does not move `nextRunAt` while the run is
   waiting. A ONCE task whose `nextRunAt` was cleared at claim time is not
   treated as unscheduled while that run is still waiting. The initial
   suspension stores no successful result.
3. A ONCE task stays `ACTIVE` while the run is `AWAITING_APPROVAL`. It becomes
   `COMPLETED` only when the resume reaches `SUCCEEDED`, `FAILED`, or
   `SKIPPED`.
4. `/api/chief/approvals` and a chat resume of that session both call
   `completeAwaitingScheduledRun`. That helper finds the run by user and
   session, requires `AWAITING_APPROVAL`, and finishes it with a
   compare-and-swap so a second decision cannot overwrite a terminal run.
   Mapped outcomes: completed → `SUCCEEDED`, suspended → `AWAITING_APPROVAL`,
   budget or model pause → `SKIPPED`, abort or throw → `FAILED`.
5. The resumed turn uses `createChiefTooling` and `createChiefTurnServices`,
   the same path as chat and the tick. If that tooling cannot be built, or the
   gates are not installed, the route returns 503 and does not execute a tool.
   The decision still goes through `ApprovalCoordinator`. A denial still
   becomes the existing synthetic error and does not run the tool body.
6. A successful resume writes operator state through the existing
   `stateFromResponse` path and stores `attention: false` from the existing
   `quietAttention()`. No notification, email, SMS, webhook, push, or
   `Notification` row is created.
7. A chat session with no awaiting scheduled run does not create or modify a
   `ChiefTaskRun`.

## Consequences

- `TurnMachine`, `ToolExecutor` gate order, `ApprovalCoordinator`, skills,
  `skill_view`, the trace schema, routing, checkpoint `fork()`, and the
  scheduler claim stay as they are.
- An approval is not sticky and is not granted by the scheduler. Another
  confirming tool suspends the same run again.
- Unanswered approvals still have no expiry.
- `finish()` used by the tick can still close a `RUNNING` run. Only the resume
  path passes `onlyFrom: AWAITING_APPROVAL`. Restricting every `finish()` to
  that status would stop the tick from recording a run.

# ADR-0005: The CHIEF scheduler tick feeds the existing turn machine

- Status: proposed with Phase 5
- Date: 2026-09-30
- Scope: `server/chief/scheduler`, `api/cron/chief-dispatch.js`, `schedule_create`

## Decision

1. There is one dispatch path: Vercel cron → `api/cron/chief-dispatch` → `runChiefTick`
   → claim → `TurnMachine.run` with `callerKind: "schedule"` and trigger
   `schedule:<taskId>`. The tick does not call a model or a tool. It builds a message and
   records the outcome. Module 01's `/api/cron/agent-dispatch` and runner are not used.
2. The database is the only scheduler state. `ChiefScheduledTask.nextRunAt` is set when
   the task is created (and back-filled by the tick for rows that lack it). A claim is a
   compare-and-swap on `(id, status ACTIVE, observed nextRunAt, lock free or stale)` that
   sets `lockedAt` and writes the advanced `nextRunAt` in the same statement (möbius
   claim-time advance). An overlapping tick sees `count 0` and does nothing.
3. Due-task enumeration and interrupted-run enumeration use the service-role client and
   read ids and owners only. Every task and run read or write happens in
   `withUserContext`.
4. Each run gets a new CHIEF session with context `{ origin: "schedule", scheduledTaskId,
runId }`. The session has no sticky approvals, so any `requiresConfirmation` tool
   suspends the turn. The run is recorded `AWAITING_APPROVAL`; nothing is auto-approved.
   That status is not terminal. Finishing the same run is ADR-0011.
5. Model budget and the `CHIEF_MODELS_ENABLED` pause are enforced by `ChiefModelEngine`
   as for a user turn. When either aborts the turn, the run is `SKIPPED`.
6. The stored prompt (`payload.prompt`) is injection-scanned at `schedule_create` and
   again before each run. A fenced prompt fails the run, pauses the task, and is audited.
   Session taint is seeded from the composed message (auto-detected PII/SECRET, plus
   EXTERNAL if the scan was not clean).
7. Operator state follows OpenJarvis `operative.py`: key `operator:{taskId}:state`,
   recalled as `## Previous State`, auto-persisted from the final answer (1000
   characters). It is stored in `chief_middleware_state` on the run's session through the
   checkpoint store. It goes into the user message, never the system prompt. Fenced state
   is dropped and audited.
8. Retry follows Hermes `cron/unreachable_retry.py`: only a transient network failure
   with zero tool calls and zero tokens, recurring tasks only, 300/900/1800 seconds,
   abandoned when the natural next occurrence comes first. Attempts are counted on the
   same `ChiefTaskRun`. Every other failure is recorded `FAILED` without retry.
9. A run left `RUNNING` longer than the 15-minute lock TTL is failed as `interrupted` and
   not re-run, since it may have executed tools.

## Consequences

- A suspended scheduled turn stays on its session. The signed-in user submits the
  decision through `/api/chief/approvals` or `/api/chief/chat`. The resume keeps
  `callerKind: "schedule"` and trigger `schedule:<taskId>`, and finishes the same
  `ChiefTaskRun` (ADR-0011). It does not run as `user_turn`.
- The cron runs every 5 minutes, at most 3 tasks per tick, and each turn has 45 seconds.
- A retried interval task re-anchors on the retry time.
- Rate-limit buckets remain per process (ADR-0004).
- The model cannot write operator state directly. Only the auto-persist path writes it.

# ADR-0010: A scheduled CHIEF turn finishes quietly

- Status: proposed with Phase 10
- Date: 2026-09-30
- Scope: `server/chief/scheduler/operative.js`, `server/chief/scheduler/tick.js`

## Context

ADR-0002 says "Nothing warrants attention" is a successful outcome and does not
notify anyone. Phase 5 runs the scheduled turn and records `SUCCEEDED`, and it
does not send anything. The outcome was still implicit: a later reader could
treat a finished run as a prompt to notify. Phase 10 makes the quiet outcome
explicit.

## Reuse check (mandatory)

- Hermes `cron/scheduler_delivery.py` (`8c30ef3`) treats an empty `deliver`
  value as `"local"`. That means no push. CHIEF has no delivery target, so
  the scheduled run is local in that same sense.
- Hermes `cron/delivery_queue.py` and `cron/bot_chat_delivery.py` are not
  ported. They queue a send and can start another chat turn.
- OpenJarvis `operative.py`, `monitor_operative.py`, and `morning_digest.py`
  (`5e5f5ef`) are not used for this decision. The digest is a second agent
  with its own delivery. `security/scanner.py` is not used.
- Module 01 `Notification` is not used. It is a different product surface,
  keyed by `agentConfigId`, and importing it would couple the scheduler to
  Module 01.

## Decision

1. `quietAttention()` returns `false` and takes no input. Model prose, an
   address, an email address, a phone number, a webhook, a tool result, and
   an instruction cannot change it.
2. The tick stores `attention: false` on the result object already passed to
   `finish()`. `MemoryTaskStore` keeps that object on the run.
   `PrismaTaskStore` encrypts it into the existing `resultCiphertext`. There
   is no new column and no migration.
3. A completed quiet run stays `SUCCEEDED`. Claim, retry, and pause are unchanged.
   Approval suspension stays non-terminal; the resume stores `attention: false`
   when that run actually ends (ADR-0011).
4. This phase sends nothing. There is no notifier, delivery queue, email,
   SMS, webhook, push, or second turn.
5. A positive notification, `attention: true` with a sender, requires a later
   audit. This decision does not authorize that sender.

## Consequences

- A prompt rejected before the turn still finishes with no result object, so
  it has no `attention` field. Only the finish path that already stored a
  turn result records `attention`. A run parked at `AWAITING_APPROVAL` also
  stores no result. The approval resume writes `attention: false` when the
  same run ends (ADR-0011).
- `TurnMachine`, `ToolExecutor`, skills, traces, routing, checkpoint `fork()`,
  and claim semantics are unchanged.
- Tests live in `test/chief-quiet-tick.test.js`.

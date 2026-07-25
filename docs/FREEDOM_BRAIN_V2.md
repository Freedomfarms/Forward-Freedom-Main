# Freedom Brain v2 — Cognitive Operating System Design

> **Status: DESIGN — awaiting review. No v2 implementation until approved.**
>
> Freedom Brain v1 (the vertical slice in `server/brain/`) removed the JSON
> envelope, introduced mid-turn tool calling, added the Context Assembler, and
> moved memory extraction into the `BrainJob` queue — all behind
> `FREEDOM_BRAIN_CHAT`. This document designs v2: the evolution from "a better
> chat engine" into a cognitive operating system. The north-star test for
> every decision in here: *does this make Freedom OS feel more like a true
> cognitive operating system?*

---

## 1. From request handler to persistent intelligence

### 1.1 What "long-lived" means on this platform

Freedom OS runs on serverless functions; there is no resident process to keep
a mind "running". v2 therefore defines persistence honestly:

**The Brain's continuity lives in durable cognitive state, not in a daemon.**

A persistent intelligence needs exactly two things this platform can provide:

1. **Durable cognitive state** — memories, plans, events, commitments, and
   reflection outcomes stored in Postgres (encrypted, RLS-forced, like
   everything else). Any invocation of the Brain — a chat turn, a cron tick, a
   capability event — rehydrates the same mind from the same state.
2. **A heartbeat** — the existing 15-minute cron tick, generalized into the
   autonomy tick (v1 already sweeps `BrainJob`s there). Cognition happens
   between conversations because the tick runs reflection, memory
   maintenance, event triage, and scheduled follow-ups without a user message.

`brainTurn()` stops being *the* Brain and becomes one of three **entry points
into the same cognitive core**:

```
                    ┌──────────────────────────────────┐
  chat turn ──────► │           Freedom Brain           │
  autonomy tick ──► │  reasoning · memory · planning    │ ──► tools/capabilities
  capability event► │  delegation · learning ·          │ ──► responses/notifications
                    │  reflection · autonomy            │ ──► background jobs
                    └──────────────────────────────────┘
                         ▲                    │
                         └── durable state ───┘
                     (UserMemory · Plan · CapabilityEvent ·
                      BrainJob · AgentRun · conversations)
```

### 1.2 The v2 cognitive loop

The v1 loop (Observe → Assemble → Recall → Reason → Tools → Reflect-on-results
→ Respond → Queue) grows two stages and becomes:

```
Observe → Understand → Plan → Execute → Reflect → Learn
```

| Stage | v2 meaning | Module |
| --- | --- | --- |
| **Observe** | Ingest the trigger: user message, due schedule, or published capability events since last contact | `server/brain/index.js` |
| **Understand** | Relevance Engine builds the Situation Brief — a curated understanding, never raw memory (§2) | `server/brain/relevance.js` (evolves `context.js`) |
| **Plan** | Load active plans; reason against them; create/update plans via tools (§3) | `server/brain/plans.js` |
| **Execute** | Tool loop — unchanged from v1, extended with plan + event tools | `server/brain/toolBelt.js` |
| **Reflect** | After significant work: did this solve the problem? what should change? (§7) | `server/brain/reflect.js` via `BrainJob` |
| **Learn** | Apply reflection output: memory lifecycle ops, plan updates, scheduled follow-ups, deferred notifications | `server/brain/jobs.js` handlers |

The Brain **owns cognition**; everything else (capabilities, tools, stores,
delivery channels) supports it. No stage adds a new orchestration layer — each
is a small module invoked from the same shallow loop (§8).

---

## 2. Relevance Engine (evolution of the Context Assembler)

### 2.1 From retrieval to attention

v1's Context Assembler retrieves fixed sections with fixed limits. The
Relevance Engine decides **what deserves attention** for *this* trigger and
produces the **Situation Brief**: a budgeted, prioritized, conflict-aware
rendering of the user's current situation. The Brain never receives raw
memory dumps.

### 2.2 Two-stage design (deterministic first)

**Stage A — Candidate gathering (cheap, deterministic).** Pull candidates per
source with generous caps: ACTIVE memories, ACTIVE plans, PENDING events,
open commitments (plan next-actions), recent decisions (DECISION memories),
recent runs, current digest, conversation tail.

**Stage B — Scoring & selection (deterministic v2.2; model-assisted later).**
Each candidate gets an attention score:

```
score = wᵣ·relevance + w꜀·confidence + wₜ·recency + boosts
```

- **relevance** — lexical/topical overlap between the candidate and the
  current message + active-conversation topics (v2.2 is keyword/category
  heuristics; embeddings are a drop-in upgrade *inside this module only*).
- **confidence** — the memory's lifecycle confidence (§5); plans and events
  carry implicit confidence (URGENT event > NOTABLE > INFO).
- **recency** — decay on `lastConfirmedAt` / `occurredAt` / `updatedAt`.
- **boosts** — `userConfirmed` memories; items linked to an ACTIVE plan;
  events not yet seen by the user; explicit financial/calendar priorities.

Selection fills a per-section token budget (the Situation Brief targets a
bounded size regardless of how much state the user accumulates over years).

**Conflict handling:** when two ACTIVE memories contradict (same subject,
incompatible content — detected at extraction time and flagged via
`supersededById` candidates), the Brief includes the winner *and* a one-line
conflict note ("Conflicting: X (older) vs Y (newer) — confirm when natural"),
so the Brain can resolve it conversationally instead of silently guessing.

### 2.3 Situation Brief shape

Rendered with the existing `dataSection` discipline:

```
CURRENT SITUATION
├─ Who the user is (top identity/preference memories)
├─ Active goals & plans (top plans: mission, next actions, stalled items)
├─ Open commitments (unfinished work the Brain or user promised)
├─ Recent decisions (last few DECISION memories)
├─ Since we last spoke (unconsumed capability events, most significant first)
├─ Conflicts needing confirmation (0–2 items)
└─ Workspace state (capability roster, recent runs, digest)
```

The Relevance Engine is the **single place** where retrieval quality lives —
same seam as v1's assembler, so v2.2 replaces the internals of one module
without touching the loop, tools, or prompts.

---

## 3. Planning Engine

### 3.1 Plans as first-class durable state

When the user expresses a mission ("I want to launch a business"), the Brain
creates an internal strategic plan and reasons against it in every relevant
turn — for weeks or months.

Plan structure (encrypted JSON body):

```
{
  mission:        string,
  objectives:     [{ id, text, status }],
  milestones:     [{ id, text, targetDate?, status }],
  dependencies:   [{ id, text, blockedBy? }],
  risks:          [{ id, text, severity }],
  completedWork:  [{ id, text, completedAt }],
  nextActions:    [{ id, text, owner: "user"|"brain", dueHint? }],
  changeLog:      [{ at, summary }]   // bounded, newest-first (last ~50)
}
```

Versioning lives in the bounded `changeLog` inside the encrypted body — no
revision table (simplicity, §8). The plan's *title* is short plaintext for
list UIs, exactly like conversation titles.

### 3.2 How plans participate in cognition

- **Understand:** the Relevance Engine injects the top-scoring active plans
  into the Situation Brief (mission + next actions + stalled milestones, not
  the full body unless the conversation is about that plan).
- **Plan:** new tools — `create_plan`, `update_plan` (structured ops: add /
  complete / revise objectives, milestones, risks, next actions),
  `get_plan` (full body when the conversation goes deep). Tool executes are
  server-validated ops, same pattern as v1's tool belt.
- **Reflect/Learn:** reflection (§7) proposes plan updates after significant
  work ("milestone X is effectively complete", "new risk discovered by the
  research capability").
- **Autonomy:** the weekly CEO review (Phase 5 of the v1 plan) reads plans
  directly: goals vs. progress vs. risks vs. opportunities.

### 3.3 Guardrails

Plans are advisory cognition, not automation: a plan's `nextActions` with
`owner: "brain"` may only schedule **read-only** work (delegated runs,
research, reminders) through the existing permission ceiling. Nothing in the
Planning Engine grants new powers.

---

## 4. Event-driven capabilities

### 4.1 Publish, don't poll

Capabilities publish **meaningful state changes** as durable events; the Brain
consumes them at its entry points instead of polling every capability every
conversation.

```
publishCapabilityEvent({
  userId,
  capability: "finance",          // registry name
  kind: "cash_flow_changed",      // capability-defined vocabulary
  severity: "NOTABLE",            // INFO | NOTABLE | URGENT
  detail: "...human-readable summary...",   // encrypted at rest
  dedupeKey: "cash_flow_changed:2026-07",   // suppress repeats in window
})
```

Publishers (initial):

| Capability | Example events | Emitted from |
| --- | --- | --- |
| Finance | `cash_flow_changed`, `unusual_spend_detected`, `budget_threshold_crossed` | finance runs + Plaid sync (`server/plaid/*` already computes deltas) |
| Research | `important_finding` (e.g. competitor announcement) | research runs |
| Reminders/Tasks | `commitment_overdue` | autonomy tick |
| Calendar (future) | `day_overloaded`, `conflict_detected` | calendar sync |
| Health (future) | `streak_broken` | integration webhook |

### 4.2 Subscription = consumption at entry points

No message broker, no pub/sub infrastructure — a Postgres table **is** the
event log (§8 simplicity; same reasoning as `BrainJob`):

- **Chat turn (Observe):** unconsumed events are ranked by the Relevance
  Engine into "Since we last spoke"; the Brain mentions what matters and marks
  them CONSUMED.
- **Autonomy tick:** URGENT events trigger immediate handling (notification
  now, or a delegated read-only run); INFO/NOTABLE events wait for the next
  conversation or the daily briefing.
- **Daily briefing:** consumes the day's events as its primary raw material —
  the briefing stops being "summarize recent runs" and becomes "what changed
  in the user's world".

Retention: CONSUMED events expire after a bounded window (they are inputs to
cognition, not an audit log — `AgentRun` remains the audit trail).

---

## 5. Memory lifecycle

### 5.1 The full lifecycle

v1 memory is create + retrieve into a capped blob. v2 gives every memory a
lifecycle so quality improves over time instead of the store growing forever:

```
        ┌──────── Confirm/Strengthen ────────┐
        ▼                                    │
Create → ACTIVE ──(decay below floor)──► ARCHIVED
        │  │
        │  └──(contradicted)──► SUPERSEDED (supersededById → successor)
        └──(user says forget)─► RETRACTED (never re-extracted) / hard delete
```

| Transition | Trigger | Effect |
| --- | --- | --- |
| **Create** | extraction, onboarding, user edit, integration observation | `confidence` seeded by source (user-stated 0.9 / integration 0.8 / inferred 0.5) |
| **Confirm** | user restates or affirms | `lastConfirmedAt = now`, `userConfirmed = true` |
| **Strengthen** | any re-confirmation | `confidence += (1 − confidence) × 0.3` (asymptotic to 0.99), `strengthenCount++` |
| **Decay** | weekly maintenance job | `confidence ×= 2^(−Δt / halfLife(category))` since `lastConfirmedAt` |
| **Archive** | `confidence < 0.30` and not `userConfirmed` | excluded from recall; kept (encrypted) for provenance |
| **Supersede** | extractor detects contradiction | old row → SUPERSEDED with `supersededById`; new row created; recall uses successor |
| **Forget** | explicit user request | RETRACTED (tombstoned — extraction may never re-add it), or hard delete on demand |

Decay half-lives by category (starting values, tuned later):

| Category | Half-life | Rationale |
| --- | --- | --- |
| PREFERENCE | 180 d | tastes drift |
| GOAL | 120 d | goals go stale fastest when unmentioned |
| DECISION | 240 d | decisions hold until revisited |
| FACT | 365 d | stable facts decay slowly |
| RELATIONSHIP | 365 d | slow-changing |
| HISTORY | none | the past does not decay |

`userConfirmed` rows never decay below 0.5 and never auto-archive — the user
said it; only the user (or supersession) can remove it.

### 5.2 Where lifecycle runs

- **Strengthen/Confirm/Supersede** — inside the async extraction job (v1's
  `memory_extraction` handler grows from "add ops" to full lifecycle ops).
- **Decay/Archive** — a new `BrainJob` kind `memory_maintenance`, enqueued
  weekly per user by the autonomy tick. Pure arithmetic — no model call.
- **Forget** — the `remember`/`forget` path: a Brain tool for explicit user
  requests, plus profile-page UI (parity with today's entry deletion).

This makes `UserMemory` (from the v1 plan, §6.1) the store that replaces the
living-profile blob — the migration path is unchanged (dual-read, one-time
backfill, freeze blob), now with lifecycle fields from day one (§10.1).

---

## 6. Capabilities, not agents

### 6.1 One intelligence, internal capabilities

The user always talks to ONE executive intelligence. Internally, everything
pluggable is a **capability** with a manifest:

```js
// server/capabilities/finance.js (registry pattern kept from server/agents/registry.js)
export const financeCapability = {
  name: "finance",
  description: "Budgets, cash flow, transactions, forecasting (read-only aggregates).",
  tools: ["get_accounts", "get_transactions_summary", "get_budget_status"],
  events: ["cash_flow_changed", "unusual_spend_detected", "budget_threshold_crossed"],
  run: runFinanceAgent,           // existing handler, unchanged
};
```

Fail-closed registration is preserved verbatim (unknown capability → typed
error; declared-but-unbuilt → refuses to run). `AgentConfig` rows survive as
**capability configurations** (schedule, instructions, model, tool allowlist)
— the schema needs no change; what changes is the mental model and, over
time, the UX.

### 6.2 UX migration (gradual, non-destructive)

- v2 keeps per-specialist chat threads working (they exist, users may use
  them) but stops presenting specialists as personalities: one conversation
  surface, one voice. Specialist chats become an "advanced" surface and are
  retired only after usage confirms the single-conversation experience covers
  them.
- The Brain's prompt already frames specialists as "internal capabilities"
  (v1). v2 removes remaining persona language from specialist run prompts —
  reports come from *Freedom OS*, not from "Fed Watcher the agent".
- Capability roster in the Situation Brief describes *what the Brain can do*,
  not *who works for the user*.

---

## 7. Reflection

### 7.1 What reflection is

After significant work completes, the Brain evaluates itself with a
constrained, cheap-tier structured call — the missing piece that closes the
loop from *doing* to *learning*:

> Did I actually solve the user's problem? Should I remember anything? Should
> I update a plan? Should I schedule follow-up work? Should I notify the user
> later?

### 7.2 Mechanics

- **Trigger** — a `BrainJob` kind `reflection`, enqueued (never inline) when a
  significance heuristic fires:
  - a delegated run completed (success or failure),
  - any mutating tool ran in a turn (create/update/delete agent, plan ops),
  - a plan was touched or a milestone completed,
  - a conversation crossed a depth threshold,
  - an URGENT capability event was handled.
- **Input** — the relevant artifact (run output / conversation tail / plan
  diff) + the Situation Brief.
- **Output — a closed vocabulary, server-validated** (this is the safety
  boundary; reflection has *no tool access* and can cause *no external
  effects*):

```
{
  assessment: "solved" | "partial" | "unsolved",
  memoryOps:   [...],               // lifecycle ops (§5), same validation as extraction
  planOps:     [...],               // plan update ops (§3), same validation as plan tools
  followUp:    { runAfter, note }?, // schedules a future BrainJob, read-only work only
  notifyLater: { title, body }?     // in-app Notification via existing self-notify path
}
```

- **Learn** — the job handler applies each op through the exact same
  allowlisted stores the interactive paths use. Reflection can never do
  anything the user-facing Brain couldn't do; it just does it without being
  asked.

### 7.3 Why async-only

Reflection must never add latency to a reply (same contract as memory
extraction) and must never loop (a reflection job cannot enqueue another
reflection — only follow-up *work*, whose completion may reflect once).
Attempt caps and backoff come free from the v1 `BrainJob` runner.

---

## 8. Architectural simplicity — enforced

### 8.1 The component budget

v2 adds capabilities without adding layers. The complete v2 runtime:

```
entry points:  chat turn · autonomy tick · capability event
core loop:     server/brain/index.js            (one loop, no dispatcher)
cognition:     relevance.js · plans.js · reflect.js · jobs.js · toolBelt.js · prompts.js
stores:        UserMemory · Plan · CapabilityEvent · BrainJob   (+ existing tables)
capabilities:  server/capabilities/* manifests → existing run handlers
```

**Banned nouns** (per review): Router, Planner*, Coordinator, Executor,
Dispatcher, Manager, Broker, Controller — none of these exist as components.
(*The Planning Engine is a *store + tools + rendering*, not an orchestration
layer that sits between the Brain and anything.)

### 8.2 The rule for new components

A new module may be created only if it (a) owns durable state, or (b) makes a
decision that must be testable in isolation. Otherwise the logic inlines into
an existing module. Every v2 module above passes: relevance (decision),
plans/events/memory (state), reflect (decision), jobs (state machine).

Infrastructure choices repeat the v1 pattern: Postgres tables instead of
queues/brokers; cron tick instead of daemons; deterministic scoring before
model-assisted scoring; encrypted JSON bodies instead of wide relational
schemas until access patterns demand otherwise.

---

## 9. Proposed schema additions

All follow house conventions: cuid PKs, `userId` cascade FK, forced RLS in
their own migration, sensitive content encrypted, plaintext limited to
non-sensitive retrieval metadata.

### 9.1 `Plan`

```prisma
enum PlanStatus {
  ACTIVE
  PAUSED
  COMPLETED
  ABANDONED
}

model Plan {
  id                    String     @id @default(cuid())
  userId                String
  // Short plaintext label for lists (same treatment as conversation titles).
  title                 String
  status                PlanStatus @default(ACTIVE)
  // Encrypted structured body: mission, objectives, milestones, dependencies,
  // risks, completedWork, nextActions, bounded changeLog (§3.1).
  contentCiphertext     String
  // Advisory planning horizon: "weeks" | "months" | "quarters".
  horizon               String?
  sourceConversationId  String?
  lastReviewedAt        DateTime?
  createdAt             DateTime   @default(now())
  updatedAt             DateTime   @updatedAt
  user                  User       @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, status, updatedAt])
}
```

### 9.2 `CapabilityEvent`

```prisma
enum CapabilityEventSeverity {
  INFO
  NOTABLE
  URGENT
}

enum CapabilityEventStatus {
  PENDING
  CONSUMED
  EXPIRED
}

model CapabilityEvent {
  id               String                  @id @default(cuid())
  userId           String
  capability       String                  // registry name: "finance", "research", …
  kind             String                  // capability-defined: "cash_flow_changed", …
  severity         CapabilityEventSeverity @default(INFO)
  // Human-readable detail — encrypted (may describe finances/schedule).
  detailCiphertext String?
  // Suppress repeat publications within the retention window.
  dedupeKey        String?
  status           CapabilityEventStatus   @default(PENDING)
  occurredAt       DateTime                @default(now())
  consumedAt       DateTime?
  expiresAt        DateTime?
  user             User                    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, status, occurredAt])
  @@index([userId, capability, kind, occurredAt])
}
```

### 9.3 `UserMemory` — lifecycle fields (extends the v1-plan schema)

Additions to the schema already specified in `docs/FREEDOM_BRAIN_PLAN.md`
§6.1 + §0.3:

```prisma
enum MemoryStatus {
  ACTIVE
  ARCHIVED     // decayed below the confidence floor; excluded from recall
  SUPERSEDED
  RETRACTED
}

model UserMemory {
  // …all fields from the v1 plan (category, contentCiphertext, confidence,
  // source, userConfirmed, sourceRef, supersededById, createdAt,
  // lastConfirmedAt)…
  strengthenCount Int       @default(0)
  lastDecayedAt   DateTime?
}
```

### 9.4 `BrainJob` — new kinds (no schema change)

`kind` is already an open string: v2 adds `"reflection"`,
`"memory_maintenance"`, and `"follow_up"` handlers to the existing registry in
`server/brain/jobs.js`. `AutonomyTask` (v1 plan §6.3) is unchanged and gains
`WEEKLY_REVIEW` consumers of plans + events.

---

## 10. Rollout — incremental, evaluated, reversible

Each increment is flag-gated or additive, ships with tests, and is evaluated
before the next begins (same discipline as the v1 slice).

| Step | Delivers | Builds on |
| --- | --- | --- |
| **v2.1 Memory lifecycle** | `UserMemory` table + lifecycle ops in the extraction handler + weekly `memory_maintenance` job + living-profile backfill (dual-read, then freeze blob) | v1 `BrainJob` runner |
| **v2.2 Relevance Engine** | `relevance.js` replaces `context.js` internals; Situation Brief; deterministic scoring + conflict notes | v2.1 memories |
| **v2.3 Planning Engine** | `Plan` table + `create_plan`/`update_plan`/`get_plan` tools + Brief injection + weekly review reads plans | v2.2 Brief |
| **v2.4 Capability events** | `CapabilityEvent` table + `publishCapabilityEvent` + finance/research publishers + "Since we last spoke" + briefing consumes events | v2.2 Brief |
| **v2.5 Reflection** | `reflection` job kind + significance heuristics + closed-vocabulary Learn handlers | v2.1–v2.4 stores |
| **v2.6 Capability UX** | Persona removal from run prompts; single-conversation-first UX; specialist chats demoted to advanced surface | product decision |

Evaluation gates: v2.1 — extraction quality vs. blob (no regressions in
profile page); v2.2 — Brief stays within token budget at 10× state volume;
v2.3 — plan drift stays coherent over multi-week simulated conversations;
v2.4 — no event spam (dedupe works); v2.5 — reflection ops are ≥90%
apply-clean (validation rejects <10%).

---

## 11. Open questions for review

1. **Embeddings** — v2.2 ships deterministic scoring; approve deferring
   pgvector until Brief quality measurably needs it?
2. **Plan bodies** — encrypted JSON with bounded changeLog (proposed) vs.
   relational plan-item rows. JSON is simpler and matches the profile/digest
   pattern; relational wins only if we need per-item queries. Recommend JSON.
3. **Event retention** — proposed: CONSUMED events expire after 30 days,
   PENDING after 14 (auto-EXPIRED, surfaced in the next briefing). Confirm.
4. **Reflection triggers** — start with the five heuristics in §7.2, or
   narrower (delegated runs only) for the first release?
5. **Specialist chat deprecation** — v2.6 demotes rather than removes.
   Comfortable committing to eventual removal, or keep indefinitely as an
   advanced surface?
6. **Health/Calendar/Email capabilities** — event vocabularies are designed
   here, but each needs its integration built first; sequencing is a product
   call outside this document.

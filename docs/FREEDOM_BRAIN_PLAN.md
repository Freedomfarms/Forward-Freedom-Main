# Freedom Brain — Architecture Plan & Proposed Database Schema

> **Status: REVIEWED — direction approved with refinements (see §0). The
> Phase 1 vertical slice (§0.6) is implemented behind `FREEDOM_BRAIN_CHAT`
> (this is Freedom Brain v1). The v2 design — cognitive loop, Relevance
> Engine, Planning Engine, capability events, memory lifecycle, reflection —
> lives in `docs/FREEDOM_BRAIN_V2.md` and supersedes this document's Phases
> 2–5 where they overlap.**
>
> This document is the first deliverable for refactoring Freedom OS from a
> workflow-driven agent system into an AI-operating-system architecture with a
> central cognitive layer ("Freedom Brain"). It maps the current system,
> identifies what is reused vs. changed, proposes the target architecture and
> database schema, and lays out an incremental migration plan that never breaks
> the running product.

---

## 0. Accepted review refinements

The architecture review accepted the plan's direction and added the following
binding refinements. Where they conflict with the original text below, these
win.

### 0.1 The Brain owns reasoning, not just routing

The Brain turn is an explicit reasoning loop, not merely "call the model with
tools". Every stage is a named seam in the code so it can evolve independently
later, even while today's implementation drives all of them through a single
Sonnet call:

```
Observe → Assemble Context → Recall Relevant Memory → Reason →
Determine Required Tools → Execute Tool Calls → Reflect On Results →
Respond To User → Queue Background Work
```

Implementation mapping (Phase 1): Observe = input validation + message
persistence; Assemble Context / Recall Memory = the Context Assembler (§0.2);
Reason / Determine Tools / Execute / Reflect = the model's tool-calling loop
(tools return structured results the model reads before composing its reply);
Respond = plain-text reply persistence; Queue Background Work = `BrainJob`
enqueue (memory extraction, titles).

### 0.2 Context Assembler

A dedicated module (`server/brain/context.js`) is the single component
responsible for context quality. It selects and curates — never dumps — the
information relevant to the current request: recent conversation, relevant
long-term memories, current goals, workspace state (roster, run summaries,
digest), connected integrations, and available tools. The Brain receives a
curated context package, not the raw database. All future retrieval
improvements (memory ranking, embeddings, relevance filters) land in this one
module.

### 0.3 Richer memory metadata

`UserMemory` (§6.1) additionally carries: a constrained `source` provenance
enum (`CONVERSATION`, `IMPORTED_DATA`, `INTEGRATION`, `USER_SETTING`,
`INFERRED`), a `userConfirmed` boolean (explicitly confirmed or entered by the
user, ranked above inferred facts), recency via `lastConfirmedAt` (already
present, used directly in retrieval ranking), and `supersededById` (already
present). The Brain reasons about trustworthiness: user-confirmed > integration
observed > inferred, weighted by confidence × recency.

### 0.4 Capability Registry, not agent personalities

Internally, "agents" are capabilities available to the Brain — finance,
research, calendar, email, tasks, documents, forecasting, planning — not
independent conversational entities. The "Agent Council" of Phase 3 is renamed
the **Capability Registry** (still built on `server/agents/registry.js`). The
user always experiences ONE intelligence; specialist execution is an internal
delegation detail.

### 0.5 Shallow runtime

No Router → Planner → Coordinator → Executor tower. The runtime is exactly:

```
Freedom Brain → Context Assembler → Claude Sonnet → Tool Calls (0-N)
             → Response → Background Jobs
```

The separate `server/brain/router.js` module from the original plan is
dropped; delegation is just the `run_agent` tool executing existing
`ceoOps.js` code.

### 0.6 Vertical slice before full migration

Implement and evaluate ONE slice before continuing: (1) remove the mandatory
JSON envelope from CEO chat, (2) introduce tool calling, (3) move memory
extraction into `BrainJob`, (4) keep all existing business logic, (5) compare
conversational quality against production. The slice ships behind the
`FREEDOM_BRAIN_CHAT` env flag with the legacy `respondToChat` path as the
default, so production comparison is a flag flip. The full migration (memory
tables, capability registry evolution, autonomy) proceeds only after the slice
proves out.

### 0.7 Preserve existing infrastructure (reaffirmed)

The LLM chokepoint, agent registry, audit pipeline, envelope encryption, RLS,
existing tool/type implementations, and the scheduler are kept as-is. The
objective is better orchestration, not replacement.

---

## 1. Executive summary

The diagnosis in the brief is accurate, with one important correction:

- **The chat model is already Sonnet-class.** `CeoAgentConfig.model` defaults to
  `claude-sonnet-4-5` (`prisma/schema.prisma`), and Haiku
  (`PROFILE_EXTRACTION_MODEL` in `server/agents/llm.js`) is only used for
  background jobs (profile extraction, conversation titles) and parts of the
  agent-creation interview. The model tier is not the core problem.
- **The core problem is the reply contract.** Every CEO chat turn forces the
  LLM to emit a single JSON object (`CEO_CHAT_REPLY_SCHEMA` in
  `server/agents/chat.js`) containing the conversational `reply` **plus**
  `profileOps` (memory extraction) **plus** `digestAction` **plus**
  `ceoActions` (platform operations) — all in one generation. Sub-agent chat
  has the same shape (`SUB_AGENT_CHAT_REPLY_SCHEMA`). The model is doing four
  jobs at once, its reply quality is hostage to schema validation, and any
  schema failure degrades the conversation.
- **The creation flow is a form wizard.** `creationInterview.js` runs a
  scripted Haiku-driven interview with sentinel state messages
  (`CREATION_STATE_SENTINEL`) hidden in the conversation, plus deterministic
  intent matchers (`matchDeterministicTaskIntent` in `chatActions.js`) that
  short-circuit the LLM entirely.
- **Memory is a capped blob, not a system.** The "living profile" is one
  encrypted JSON blob on `CeoAgentConfig.profileCiphertext` with five fixed
  categories capped at 15 entries each, updated synchronously inside the chat
  JSON envelope.

The refactor therefore has one central move: **replace the one-shot JSON
envelope with a native tool-calling loop** where the model's final output is
plain conversational text and every side effect (platform ops, digest edits,
specialist delegation) is a first-class tool the model may call mid-turn.
Memory extraction leaves the chat turn entirely and becomes an asynchronous
job. Everything else — encryption, RLS, Plaid, the runner, the cron
dispatcher, the frontend chat UI — is preserved and reused.

---

## 2. Current-state map

### 2.1 Stack

| Layer | Implementation |
| --- | --- |
| Frontend | React + Vite SPA in `/src` (this is the **frontend** — see §4.2) |
| API | Vercel serverless functions in `/api`, mirrored by Express in `server/index.js` for local dev |
| Domain logic | `/server` (agents, auth, db, plaid, security) |
| DB | PostgreSQL via Prisma 7, envelope encryption (`server/security/envelope.js`), forced RLS (`docs/RLS_ROLLOUT.md`) |
| LLM | Anthropic only, via Vercel AI SDK; single chokepoint `server/agents/llm.js` |
| Scheduling | Vercel cron → `GET /api/cron/agent-dispatch` every 15 min |

### 2.2 Existing agent platform (all in `server/agents/`)

```
User ─► api/agents/ceo/chat.js ─► respondToChat (chat.js)
              │                        │ loads: 50 msgs, profile, roster,
              │                        │ 20 run summaries, digest, 8 docs
              │                        ▼
              │                one-shot generateAgentText + Output.object
              │                (reply + profileOps + digestAction + ceoActions)
              │                        │
              │                server applies actions AFTER generation
              ▼
        runAgent (runner.js) ─► registry.js ─► types/{finance,research,reminders}.js
              │
              └─► extractFromRun (profile.js, Haiku) ─► profileCiphertext blob
```

### 2.3 What can be reused (and will not be rewritten)

| Asset | Location | Role in new architecture |
| --- | --- | --- |
| LLM chokepoint + test override | `server/agents/llm.js` | Brain's only model I/O path; keeps `setLlmImplementationForTesting` |
| Model allowlist | `server/agents/models.js` | Brain model policy (Sonnet floor for chat) |
| Agent registry (fail-closed) | `server/agents/registry.js` | Becomes the Agent Council roster |
| Specialist handlers | `server/agents/types/*.js` | Council members, unchanged internally |
| Run persistence + audit | `server/agents/runner.js`, `AgentRun` | Specialist execution record, unchanged |
| Conversations + encrypted messages | `conversations.js`, `AgentConversation`, `AgentChatMessage` | Brain's conversation store, unchanged |
| Prompt-injection defenses | `prompts.js` (`dataSection`, safety rules) | Reused verbatim in Brain prompts |
| Cron dispatcher | `api/cron/agent-dispatch.js` | Extended into the Autonomy service |
| Platform ops | `ceoOps.js` (create/update/run/delete agent, set_timezone) | Re-exposed as Brain tools |
| Digest generation | `digest.js` | Becomes the Daily Briefing engine |
| Email delivery + template | `emailDelivery.js`, `emailTemplate.js` | Briefing/review delivery |
| Envelope encryption + RLS | `server/security/`, migrations | Applies to all new tables |
| Living-profile data | `CeoAgentConfig.profileCiphertext` | Migrated into `UserMemory` (see §6.4) |

### 2.4 What changes

| Problem | Current code | Change |
| --- | --- | --- |
| Chat reply is structured JSON | `CEO_CHAT_REPLY_SCHEMA`, `SUB_AGENT_CHAT_REPLY_SCHEMA` in `chat.js` | Plain-text final output; actions become tools |
| Memory extraction inline in chat | `profileOps` in the same generation | Async `BrainJob` after the reply is sent |
| Scripted creation interview | `creationInterview.js`, `creationFlow.js`, `creationDraft.js`, `creationState.js` | Brain asks naturally; `create_agent` tool executes when ready |
| Deterministic intent short-circuits | `matchDeterministicTaskIntent` in `chatActions.js` | Removed once tool loop reaches parity (kept behind flag during rollout) |
| Memory is a capped blob | `profile.js`, 15 entries/category | Row-per-memory `UserMemory` table with confidence + recency |
| One hardcoded tool | web search only (`getWebSearchTools`) | Tool registry with permissions and schemas |
| Digest only | `digest.js` | Daily briefing + weekly CEO review + scheduled tasks |

---

## 3. Target architecture

```
User
 ↓
Freedom Brain            server/brain/       conversational loop, intent, tool use
 ↓
Agent Router             server/brain/router.js   delegate-to-specialist decisions
 ↓
Specialized Agents       server/agents/      finance / executive-assistant / research (council)
 ↓
Tools / Integrations     server/tools/       registry: Plaid, schedule, web search, …
 ↓
Memory System            server/memory/      UserMemory store + async extraction
 ↓
Autonomy                 server/autonomy/    briefings, reviews, scheduled tasks
```

### 3.1 The Brain turn (replaces `respondToChat`'s one-shot generation)

1. **Receive** user message (same API routes: `POST /api/agents/ceo/chat`).
2. **Load context** (reusing existing loaders): last 50 messages, team roster,
   recent run summaries, reference docs, timezone, digest — **plus** relevant
   `UserMemory` rows (new).
3. **Generate with tools** — `generateAgentText` with `stepCountIs(N)` and the
   tool belt below. The model reasons, optionally calls tools mid-turn, and
   produces a **plain-text reply**. No output schema. No required JSON.
4. **Persist** the reply (existing encrypted message path).
5. **Enqueue** a `memory_extraction` `BrainJob` (fire-and-forget; the response
   never waits on it).

Brain tool belt (Phase 1 scope, all wrapping existing server code):

| Tool | Wraps |
| --- | --- |
| `search_web` | existing Anthropic provider tool |
| `create_agent`, `update_agent`, `run_agent`, `delete_agent`, `set_timezone` | `ceoOps.js` |
| `update_digest` | `digest.js` (`set_content` / `regenerate`) |
| `remember` | explicit high-confidence memory write (user says "remember that…") |

Because tools execute **during** the turn (not parsed out afterwards), the
model can create an agent, run it, and report the result in one natural reply —
today that requires the fragile `__last_created__` convention inside one JSON
object.

### 3.2 Module layout

```
server/
  brain/
    index.js          # brainTurn({ userId, conversationId, message }) entrypoint
    context.js        # Context Assembler (messages, memories, roster, docs, digest)
    jobs.js           # BrainJob queue (enqueue + worker dispatch)
    prompts.js        # Brain persona/system prompt (plain-text reply contract)
    toolBelt.js       # binds tool registry entries into an AI-SDK tool set
  memory/
    store.js          # UserMemory CRUD (encrypt/decrypt, confidence, confirmation)
    retrieval.js      # relevance selection for prompt injection
    extraction.js     # async extraction worker (Haiku) — consumes BrainJob
    migrate.js        # one-time living-profile → UserMemory backfill
  tools/
    registry.js       # defineTool / getToolsForAgent (permissions enforced)
    finance.js        # get_accounts, get_transactions_summary, get_budget_status
    assistant.js      # get_schedule, create_reminder, list_tasks
    research.js       # search_information (web search wrapper)
    platform.js       # create_agent, update_agent, run_agent, delete_agent, …
  agents/             # EXISTING — evolves in place (council members + runner)
  autonomy/
    scheduler.js      # generalized dispatcher (agents + briefings + reviews + jobs)
    briefing.js       # daily briefing (evolved digest.js)
    review.js         # weekly CEO review
    jobs.js           # BrainJob queue worker (memory extraction, titles, …)
```

### 3.3 Directory conflict — decision needed at review

The brief asks for `/src/brain`, `/src/memory`, `/src/agents`, `/src/tools`,
`/src/autonomy`. In this repository **`/src` is the React frontend** bundled by
Vite; backend code lives in `/server` and would break the build (and leak
server code to the client) if placed under `/src`. **Recommendation:** create
the five modules under `/server` as shown above (`server/brain`,
`server/memory`, `server/tools`, `server/autonomy`, with `server/agents`
already existing). If a literal `/src/*` layout is required, the alternative is
a repo-wide restructure moving the frontend to `/client` first — far more
invasive and orthogonal to the Brain work. Flagged for review.

### 3.4 Model policy

| Role | Model | Notes |
| --- | --- | --- |
| Brain conversation | `claude-sonnet-4-5` (user-upgradable to Opus) | Already the stored default; add a **Sonnet floor** so the Brain never runs chat on Haiku even if a stale config says so |
| Specialist runs | per-`AgentConfig.model` (Sonnet default) | unchanged |
| Background extraction / titles / briefing assembly | `claude-haiku-4-5` | correct use of the cheap tier; unchanged |

---

## 4. Phase plan

### Phase 1 — Conversation Intelligence

**Goal:** the Brain feels like a knowledgeable executive assistant, not a form
wizard.

- Add `server/brain/` with `brainTurn()` implementing §3.1, behind a feature
  flag (`FREEDOM_BRAIN_CHAT=1`, or per-user allowlist) so
  `respondToChat` remains the fallback until parity.
- Final output is plain text; retry-on-empty logic kept; schema-validation
  failure modes disappear.
- Retire the scripted creation interview: the Brain gathers what it needs
  conversationally and calls `create_agent` when ready. The deterministic
  intent matchers stay active under the flag until the tool loop demonstrably
  covers them (existing tests in `/test` define parity).
- Sub-agent chats move to the same loop with a narrower tool belt
  (`update_own_config`, `run_self`, `email_report` — wrapping
  `chatActions.js`).
- Frontend: **no changes required** — API request/response shape
  (`{ reply, messageId, conversationId, … }`) is preserved.

**Exit criteria:** existing `/test` agent-chat suites pass against the Brain
path (via `setLlmImplementationForTesting`); creation, delegation, digest
edits, and scheduling all work through tools; flag flipped to default-on.

### Phase 2 — Memory Architecture

**Goal:** durable, queryable, per-fact memory with async extraction.

- New tables `UserMemory` and `BrainJob` (schema in §6).
- After each Brain reply, enqueue `memory_extraction` with only IDs in the
  payload (no plaintext). Worker (Haiku) reads the recent exchange, writes
  `UserMemory` rows: new facts, confidence updates (`lastConfirmedAt` bump on
  re-confirmation), retractions (status `RETRACTED`, replacing the blob's
  tombstone concept).
- **Serverless constraint:** Vercel functions can't reliably do post-response
  work. Dual trigger: best-effort `waitUntil` after responding, **plus** the
  15-minute cron sweeps `BrainJob` rows still `PENDING` (at-least-once,
  idempotent by job ID).
- Retrieval v1 is deterministic (no embeddings): top-N per category ranked by
  `confidence × recency(lastConfirmedAt)`, injected via `dataSection`.
  Optional v2: pgvector similarity — schema reserves the column decision but
  it is **not** in the initial migration.
- One-time backfill migrates living-profile entries into `UserMemory`
  (category mapping in §6.4). During transition the Brain reads both; writes
  go only to `UserMemory`; `profileCiphertext` is frozen and later removed.

**Exit criteria:** chat latency unchanged (extraction fully async); profile
page renders from `UserMemory`; blob is read-only legacy.

### Phase 3 — Capability Registry (formerly "Agent Council")

**Goal:** specialists are capabilities of ONE intelligence, not parallel
chatbots (§0.4).

- Delegation is the `run_agent` tool: it resolves the specialist through the
  existing registry, executes via `runAgent` (sync budget ≈45 s then async
  with `notifyCeoDelegatedRunComplete` — both already exist), and returns
  results into the Brain conversation. No separate router layer (§0.5).
- Capability roster (extends `registry.js`, same fail-closed pattern):
  - **Finance Agent** — exists (`types/finance.js`): Plaid-derived aggregates,
    budgets, forecasting, transactions.
  - **Executive Assistant Agent** — evolution of `types/reminders.js`:
    reminders + tasks now; calendar when a calendar integration lands
    (tool-gated, see Phase 4).
  - **Research Agent** — exists (`types/research.js`): web research, reports,
    analysis.
- New-agent contract: one module in `server/agents/types/`, a registry entry,
  and a declared tool allowlist. Nothing else.
- Specialist chats remain available for deep follow-up on a specialist's own
  work (current scoping contract in `chat.js` is kept), but all cross-agent
  orchestration flows through the Brain.

### Phase 4 — Tool System

**Goal:** every capability is a described, permissioned, schema'd tool.

- `server/tools/registry.js`:

  ```js
  defineTool({
    name: "get_accounts",
    description: "Account balances and types for the user's linked institutions.",
    inputSchema:  { /* JSON Schema */ },
    outputSchema: { /* JSON Schema */ },
    permission: "READ_ONLY",          // min AgentPermissionLevel required
    dataAccessed: ["plaid_aggregates"], // feeds AgentRun.dataAccessed audit
    execute: async (input, ctx) => { … }, // ctx: { userId, agentConfig, runId }
  });
  ```

- `getToolsForAgent(agentConfig)` intersects the registry with the agent's
  `toolAccess` JSON allowlist (field already exists on `AgentConfig`) and
  permission level, then adapts entries to AI-SDK tools. Grants live in the
  existing column — **no new grants table**; a `ToolInvocation` audit table is
  optional (§6.3) and can be deferred in favor of `AgentRun.dataAccessed`.
- Initial tool set: `get_accounts`, `get_transactions_summary`,
  `get_budget_status` (finance — respecting the existing data-minimization
  rule: aggregates only, never raw merchants/amounts, per `docs/SECURITY.md`);
  `get_schedule`, `create_reminder`, `list_tasks` (assistant);
  `search_information` (research); platform ops (Brain-only).
- Permission ceiling unchanged: runtime allows `READ_ONLY` / `DRAFT_ONLY`
  only; no tool may move money or contact third parties.

### Phase 5 — Autonomous Operations

**Goal:** the system works for the user between conversations.

- `server/autonomy/scheduler.js` generalizes `api/cron/agent-dispatch.js`: one
  15-minute tick dispatches (a) due agent runs (existing `isAgentDue`), (b)
  due `AutonomyTask` rows, (c) pending `BrainJob` rows. Same `CRON_SECRET`
  fail-closed auth and per-invocation caps.
- **Daily briefing** — evolves `digest.js`: financial changes (finance
  aggregates), upcoming schedule/reminders, priorities from `UserMemory` goals,
  recommendations. Delivered as the digest is today (cached on config, in-app
  `Notification`, optional Resend email using the executive template).
- **Weekly CEO review** — new: goals (from `UserMemory` GOAL rows) vs. run
  outcomes, progress, risks, opportunities; delivered Monday-morning-style in
  the user's timezone (`User.timezone` already exists).
- Schedules stored per user in `AutonomyTask` (cron string in UTC, computed
  from local time — same convention as agent schedules in `schedule.js`).

---

## 5. Migration plan (incremental, non-destructive)

| Step | Change | Risk containment |
| --- | --- | --- |
| 1 | Add `server/brain/` + tool registry wrapping `ceoOps`/`digest`; feature-flagged Brain path in the CEO chat route | Legacy `respondToChat` untouched; flag off by default |
| 2 | Parity-test Brain path against existing `/test` chat suites; enable flag for internal users | Instant rollback = flip flag |
| 3 | Migration: `UserMemory` + `BrainJob` tables (+ RLS policies per `docs/RLS_ROLLOUT.md`) | Additive-only migration; no existing table altered |
| 4 | Async extraction worker + cron sweep; Brain enqueues jobs | Chat ignores job outcomes; failure = missing memory, never a broken reply |
| 5 | Backfill living profile → `UserMemory`; Brain reads both; writes only new store | Blob preserved as fallback until verified |
| 6 | Default Brain path on; retire creation-interview modules and deterministic matchers; sub-agent chats join the loop | Old modules deleted only after a full release cycle |
| 7 | `AutonomyTask` migration; scheduler generalization; weekly review | Cron logic changes are additive; agent dispatch behavior preserved |
| 8 | Remove `profileCiphertext` blob + legacy JSON reply schemas | Final cleanup, separate PR |

Explicitly **not** rewritten: envelope encryption, RLS setup, Firebase auth
wrappers, Plaid sync, the runner/audit pipeline, email delivery, the React
chat UI, the Express/Vercel dual-deploy pattern.

---

## 6. Proposed database schema

All new tables follow existing conventions: cuid PKs, `userId` FK with cascade
delete, RLS policies (owner-only via `freedom_app`, service bypass only through
`servicePrisma.js`), sensitive content encrypted with the envelope helper,
plaintext limited to non-sensitive retrieval metadata.

### 6.1 `UserMemory`

```prisma
enum MemoryCategory {
  FACT          // stable facts about the user's life/finances
  GOAL          // objectives the user is working toward
  PREFERENCE    // how they like things done (tone, cadence, formats)
  DECISION      // choices the user has made ("we decided to…")
  RELATIONSHIP  // people, advisors, institutions and their roles
  HISTORY       // important events / background context
}

enum MemoryStatus {
  ACTIVE
  SUPERSEDED    // replaced by a newer memory (supersededById set)
  RETRACTED     // user corrected/deleted it — never re-extract (replaces blob tombstones)
}

enum MemorySource {
  CONVERSATION   // extracted from chat with the Brain
  IMPORTED_DATA  // onboarding, reference documents, profile migration
  INTEGRATION    // observed via a connected integration (Plaid, calendar, …)
  USER_SETTING   // explicitly entered/edited by the user in the UI
  INFERRED       // deduced by the Brain, not directly stated
}

model UserMemory {
  id                String         @id @default(cuid())
  userId            String
  category          MemoryCategory
  // Memory text is sensitive → encrypted at rest, like chat content.
  contentCiphertext String
  // 0.0–1.0; extraction sets initial value, re-confirmation raises it,
  // contradiction lowers it or supersedes the row.
  confidence        Float          @default(0.7)
  source            MemorySource
  // True when the user explicitly stated/confirmed the fact (ranked above
  // inferred facts during recall — see §0.3 trust ordering).
  userConfirmed     Boolean        @default(false)
  // Optional pointer to the originating conversation, run, or integration.
  sourceRef         String?
  status            MemoryStatus   @default(ACTIVE)
  supersededById    String?
  supersededBy      UserMemory?    @relation("MemorySupersession", fields: [supersededById], references: [id], onDelete: SetNull)
  supersedes        UserMemory[]   @relation("MemorySupersession")
  createdAt         DateTime       @default(now())
  lastConfirmedAt   DateTime       @default(now())
  updatedAt         DateTime       @updatedAt
  user              User           @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, category, status, lastConfirmedAt])
  @@index([userId, status, lastConfirmedAt])
}
```

Covers every required field: `userId`, `category`, `content`, confidence
score, created date, last-confirmed date — plus provenance and supersession so
the extractor can update beliefs instead of appending duplicates. Embeddings
(pgvector) are deliberately deferred; deterministic ranking ships first.

### 6.2 `BrainJob` (async work queue)

```prisma
enum BrainJobStatus {
  PENDING
  RUNNING
  COMPLETED
  FAILED      // terminal after maxAttempts
}

model BrainJob {
  id          String         @id @default(cuid())
  userId      String
  // "memory_extraction" | "conversation_title" | "briefing_refresh" | …
  kind        String
  // IDs only (conversationId, messageId, runId) — never plaintext content.
  payload     Json
  status      BrainJobStatus @default(PENDING)
  attempts    Int            @default(0)
  runAfter    DateTime       @default(now())
  // Claim marker so cron sweep and waitUntil never double-process.
  lockedAt    DateTime?
  lastError   String?
  createdAt   DateTime       @default(now())
  completedAt DateTime?
  user        User           @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([status, runAfter])
  @@index([userId, kind, createdAt])
}
```

This is the mechanism that lets the chat response return **before** memory
extraction runs, on a serverless platform with no resident worker.

### 6.3 `AutonomyTask` and optional `ToolInvocation`

```prisma
enum AutonomyTaskKind {
  DAILY_BRIEFING
  WEEKLY_REVIEW
  AGENT_TASK      // scheduled Brain-initiated work not tied to one agent config
}

model AutonomyTask {
  id        String           @id @default(cuid())
  userId    String
  kind      AutonomyTaskKind
  // UTC cron, computed from the user's local time (same as AgentConfig.schedule).
  schedule  String
  enabled   Boolean          @default(true)
  // Kind-specific settings (sections to include, delivery channel, …).
  config    Json?
  lastRanAt DateTime?
  createdAt DateTime         @default(now())
  updatedAt DateTime         @updatedAt
  user      User             @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([enabled, schedule])
  @@index([userId, kind])
}

// OPTIONAL (deferrable): per-call tool audit. AgentRun.dataAccessed already
// records what a run touched; add this only if per-invocation audit is wanted.
model ToolInvocation {
  id            String    @id @default(cuid())
  userId        String
  agentConfigId String?   // null = Freedom Brain itself
  runId         String?
  toolName      String
  // Minimized metadata only (arg names / entity counts), never raw values.
  inputSummary  Json?
  status        String    // "ok" | "error" | "denied"
  createdAt     DateTime  @default(now())
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, toolName, createdAt])
  @@index([runId])
}
```

No changes to `AgentConfig`, `AgentRun`, `AgentConversation`, or
`AgentChatMessage` are required in Phases 1–4. Tool grants reuse the existing
`AgentConfig.toolAccess` JSON column.

### 6.4 Living-profile → memory backfill mapping

| Blob category | `MemoryCategory` |
| --- | --- |
| `financialGoals` | `GOAL` |
| `knownAccountsRelationships` | `RELATIONSHIP` |
| `statedPreferences` | `PREFERENCE` |
| `recurringConcerns` | `FACT` (or `GOAL` if phrased as an objective — extractor decides) |
| `lifeContext` | `HISTORY` |
| tombstones | `RETRACTED` rows (so extraction never resurrects deleted facts) |

Each migrated row: `source = IMPORTED_DATA` (or `USER_SETTING` for
user-edited entries), `sourceRef` = blob entry id, `userConfirmed = true` for
onboarding/user-edited entries, `confidence = 0.8` (user-curated data),
`createdAt`/`lastConfirmedAt` from the entry's `addedAt`/`updatedAt`.

---

## 7. Risks & open questions for review

1. **Directory layout** (§3.3): approve `server/brain|memory|tools|autonomy`
   instead of literal `/src/*`? `/src` is the React bundle in this repo.
2. **Creation-interview retirement pace**: the interview modules have heavy
   test coverage and known UX; proposal is flag-gated coexistence, deleting
   only after the Brain path passes those suites. Confirm appetite.
3. **`ToolInvocation` table**: ship in Phase 4 or defer and rely on
   `AgentRun.dataAccessed`? Recommendation: defer.
4. **Embeddings**: deterministic memory ranking first; pgvector only if
   retrieval quality demands it (adds an extension dependency to the managed
   Postgres). Confirm.
5. **Sub-agent chat identity**: once the Brain orchestrates everything, do
   per-specialist chat threads remain user-facing, or become an advanced
   surface? Plan assumes they remain (scoped tool belts), matching current UX.
6. **Cost**: tool-loop turns can use more steps than one-shot generation
   (mitigated by `stepCountIs` caps); async extraction stays on Haiku. Usage
   accounting via `costs.js` continues to apply.

---

## 8. Deliverable checklist vs. the brief

| Requirement | Where addressed |
| --- | --- |
| Review current repository / map architecture | §2 |
| Identify reuse | §2.3 |
| Migration plan, no blind rewrite | §5 |
| Brain: receive → memory → history → intent → answer/delegate → tools → async memory → natural reply | §3.1 |
| Sonnet-class primary model | §3.4 (already default; floor added) |
| No structured-JSON dependency for chat | §3.1, Phase 1 |
| Memory schema (categories, confidence, dates) | §6.1 |
| Async extraction, non-blocking chat | §6.2, Phase 2 |
| Agent council (finance / EA / research), easy extension | Phase 3 |
| Tool registry (permissions, descriptions, I/O schemas) | Phase 4, §6.3 |
| Autonomy (daily briefing, weekly review, scheduled tasks) | Phase 5, §6.3 |
| Module directories | §3.2 / §3.3 (decision requested) |
| Plan before implementation | This document; no code changed |

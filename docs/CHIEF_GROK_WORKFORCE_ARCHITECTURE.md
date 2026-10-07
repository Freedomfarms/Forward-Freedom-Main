# CHIEF × Grok Bot — Observability Architecture (audit)

Status: approved direction. Both ingest paths stay first-class in the journal.
See [CHIEF_CONTROL_PLANE_PLAN.md](./CHIEF_CONTROL_PLANE_PLAN.md) and
ADR-0025 / ADR-0026 / ADR-0027. Enterprise OpenTelemetry is not configured in
this environment, so Phase C connects the self-report ingress only. OTEL remains
unconnected. CHIEF still has no workforce read tool.

Original audit (2026-10-02), against Freedom OS `main` at `c85515a` and the public docs listed
in each section.

Governing boundary:

> Grok Bot runs the work. Freedom OS connects to it. CHIEF sees the work, understands
> it, reports it, and later can draw it. CHIEF does not become an agent workforce.

---

## 0. Decision this audit asks you to approve

Grok Bot does **not** expose an agent API, a task API, webhooks, or a stream that a
third-party app can subscribe to. That was verified against the official docs index and
the live OpenAPI document, not assumed.

The only platform mechanism that lets an external system observe the Grok Bot workforce
is **Cursor Enterprise OpenTelemetry Export** of Action Recording, tagged
`cursor.surface=grok_bot`. It is metadata about actions. Findings, task names, and bot
display names are not on that feed unless a separate, opt-in conversation-content
export is also enabled, and even then there is still no task object.

Everything else an outside app can do is ask a Bot to report on itself. That report is
useful and incomplete. It is not a platform guarantee.

The recommended shape is one Freedom OS journal with two ingress adapters:

1. **Platform adapter** — receive the Enterprise OTEL log stream. This is the
   observability path.
2. **Annotation adapter** — accept a small authenticated report when a Bot (or a
   person) states mission, task, blocker, or finding in words the telemetry will never
   carry. This is untrusted text, correlated to the platform feed when both exist.

CHIEF reads that journal through the turn machine it already has. It does not run the
bots.

Two-way control (CHIEF assigning work to Grok Bot) is not trivial and is not in this
design. There is no submit-task API to wrap.

---

## 1. Current CHIEF architecture

CHIEF today is a conversational control surface inside Freedom OS. It is not a running
agent workforce.

### What is live

| Piece | Where | What it actually does |
| --- | --- | --- |
| Turn machine | `server/chief/runtime/turn.js` | One durable, resumable conversation turn: prepare → model → authorize tools → execute or suspend for approval → complete. Serverless: state is in Postgres, not a resident process. |
| Tool executor | `server/chief/tools/executor.js` | The only tool path. Gate order is fixed. |
| Sessions and history | `ChiefSession` and journals; `api/chief/chat`, `sessions`, `history` | Checkpoint, transcript deltas, execution journal, event journal. Archive and recall exist. |
| Provider layer | `server/chief/models/providers.js` | AI SDK. xAI Grok is the primary language model (`CHIEF_XAI_API_KEY` or `XAI_API_KEY`) via `@ai-sdk/xai`. Anthropic and OpenAI are alternate transports. This calls `api.x.ai`. It does not talk to Grok Bot. |
| Budget | `ChiefBudget`, `server/chief/models/budget.js` | Spend cap checked in the model layer. |
| Traces | `ChiefTrace`, `ChiefTraceStep` | A collector records route / retrieve / generate / tool_call / respond for turns CHIEF itself ran. It does not store the query, the answer, or tool output. |
| Scheduler | `server/chief/scheduler/`, `api/cron/chief-dispatch` | Claims `ChiefScheduledTask` rows and runs each due task as one TurnMachine session. Quiet by default. |
| Approvals | `ChiefApproval`, `api/chief/approvals` | A confirming tool suspends the same session until the signed-in user decides. |
| Context | `server/chief/context/` | System prompt from a persona fact, trust-filtered recall, skills index. |
| Skills | `server/chief/skills/` | Bundled `SKILL.md` documents loaded by `skill_view`. They are procedures for CHIEF's own tools, not a runner. |
| Auth and isolation | Firebase bearer on `api/chief/*`; Postgres RLS; encryption helpers | Every `chief_*` row is owned by one `userId`. |
| Room UI | `src/visual/chiefWorld/ChiefWorld.jsx`, `src/components/chief/ChiefPage.jsx` | The signed-in CHIEF home mounts the isolated spatial world. Existing CHIEF status and voice drive that presentation. Conversation, approvals, and the model picker stay on the Convos surface. The vendored APEX shell remains in the tree and is not mounted. |
| Entry diamond | `src/components/chief/chiefField.js`, entry gateway | The Freedom Diamond presentation still exists for the entry gateway. This phase does not touch it. |

`docs/CHIEF_ARCHITECTURE.md` still describes a future Command Center whose primary
surface is a vendored cortex-map, with CHIEF-owned managed agents as hubs. That
renderer is **not** in the repository. The live room is the vendored APEX shell. This
audit does not revive that UI plan and does not replace the diamond model that
remains in the codebase.

### What exists in the schema and is not a workforce

`ChiefAgent`, `ChiefAgentTask`, and `ChiefAgentMessage` are migrated and covered by
RLS tests. No CHIEF runtime writes them. They were specified as a port of OpenJarvis's
local managed-agent store: agents Freedom OS would own and tick.

They stay dormant. Mapping Grok Bots into those rows would blur "CHIEF owns this
agent" with "CHIEF observed this agent." A later implementation uses new tables.

### What this phase reuses

- TurnMachine, as the place a person asks "what's happening?"
- ToolExecutor, as the place a new read-only picture tool is gated
- Sessions, provider, budget, traces, auth, RLS, encryption
- The scheduler only later, and only to mark observed agents stale on a tick. It does
  not gain a second agent loop

### What this phase leaves alone

CEO Agents (`server/agents`, `api/agents`, the CEO brain), the financial Command
Center, Freedom Financial writes, the Freedom Diamond / particle-field renderers, and the
unused `ChiefAgent*` lifecycle.

---

## 2. Current Grok integration

Freedom OS integrates **xAI's model API**, not Grok Bot.

- Transport: `@ai-sdk/xai`, registered as provider `xai` in
  `server/chief/models/providers.js`.
- Credential: `CHIEF_XAI_API_KEY`, else `XAI_API_KEY`. Optional `CHIEF_XAI_BASE_URL`.
- Use: CHIEF's own turns (chat, extraction, scheduled turns). Streaming, tool calls,
  and budget all happen inside TurnMachine.
- There is no Grok Bot client, no bot roster, no OTEL receiver, and no inbound
  webhook from xAI or Cursor.

An `XAI_API_KEY` authorizes `https://api.x.ai`. It does not authorize the Grok Bot
app. Grok Bot sign-in is Cursor (or a linked SuperGrok account). Those are different
credentials and different products.

Three xAI products are easy to conflate. Only the third is the workforce:

| Product | What it is | Observability relevant here |
| --- | --- | --- |
| xAI API (`api.x.ai`) | Model inference: Responses, tools, files, batches, hosted skills | CHIEF already uses this as its language model. It cannot list or watch Grok Bots. |
| Grok Build (`docs.x.ai/build`) | Local coding CLI with sessions, subagents, and HTTP hooks | Hooks can POST lifecycle events. They observe a local Grok Build session, not the Grok Bot workforce. Out of scope. |
| Grok Bot (`docs.x.ai/grok-bot`, `x.ai/bot`) | Durable named teammates on a Cursor-hosted cloud computer, desktop and mobile | This is the workforce. See §3. |

---

## 3. Grok Bot capabilities

Sources checked on 2026-10-02:

- Docs index: `https://docs.x.ai/llms.txt` (Grok Bot section, 22 pages)
- OpenAPI: `https://docs.x.ai/openapi.json` — **38 paths**, listed below
- Grok Bot security: `https://docs.x.ai/grok-bot/security`
- Cursor OpenTelemetry export and wire reference:
  `https://cursor.com/docs/enterprise/opentelemetry-export`
  and `.../opentelemetry-export/wire`

### 3.1 What the product is

A Bot is a durable teammate: a name, a job, its own conversation, and working context.
All of one member's Bots share one cloud computer (files, browser sessions, logins).
Each Bot has its own screen. Bots message each other and can sit in a group chat of
two to six. Routines run a workflow on a schedule or, where supported, from a Cursor
account event such as Slack or GitHub. An account allows up to 50 Bots and group
chats combined.

The transcript inside the app shows tool activity, computer use, files, questions,
and approval requests. That view is not an API.

### 3.2 Capability verdict

| Question | Verdict | Closest supported mechanism |
| --- | --- | --- |
| Agent API (list, create, inspect bots) | **Does not exist** on `api.x.ai` or in the Grok Bot docs | In-app sidebar only |
| Agent / task API | **Does not exist.** There is no task resource | In-app transcript; routines have an in-app run history |
| Agent status | **No query API** | Infer activity from OTEL action logs after the fact (§3.3) |
| Task status | **No task object** | Routine-run outcome exists (`success`, `error`, `cancelled`) for finished routine runs only |
| Execution history | **No REST history** | Enterprise Action Recording, exported as OTEL logs, about 7 days upstream |
| Events | **No webhook product for Grok Bot** | OTEL logs, pushed to a collector the team configures |
| Webhooks | **Not a Grok Bot feature** | Grok Build HTTP hooks are a different product. Cursor integrations can *start* a routine; they do not emit bot activity |
| Streaming to an external app | **Does not exist** | The app streams into its own transcript |
| Logs | **Enterprise only** | Audit logs (control plane) and Action Recording (bot actions). Self-serve Teams do not get them |
| Tool activity | **Metadata, Enterprise OTEL** | `tool_result`, `mcp_tool_call`, `shell_command`, `browser_navigation`, `computer_use_session`, `file_transfer`, `tool_decision` |
| Results / findings | **Not on the default feed** | Opt-in conversation content: scrubbed prompts and assistant text (32 KiB) and HTTP MCP tool I/O (8 KiB per side). Shell text is scrubbed and capped at 8 KiB on the action event itself |
| Agent metadata (name, job, description) | **Not exported** | `cursor.conversation.id` is the Bot's stable id. The human name stays in the app unless a Bot reports it |
| Task metadata | **Does not exist** | Turns, tool calls, routines, and delegations are the real objects |
| Agent relationships | **Partial, on OTEL** | Peer send (`message_delivery` destination `agent`), subagent id, delegation to a subagent or a Cursor cloud agent |
| External callbacks into Freedom OS | **Does not exist** | A Bot can call an HTTPS or MCP tool if a person installs that connector and the network policy allows the host |
| Authentication for bots | **Cursor SSO / SuperGrok link** | Not an API key. xAI API keys do not grant bot access |
| API access | **Model API only** | OpenAPI paths are inference, files, batches, collections, embeddings, and hosted `SKILL.md` packages (`/v1/skills`). None are bots |
| Mechanism for an external app to observe | **One, and it is Enterprise** | OpenTelemetry Export. See §3.3 |

`/v1/skills` hosts skill zip files for the model API (`SKILL.md` frontmatter). It is
not the Grok Bot roster and it does not list routines.

`grok-4.20-multi-agent` on the Responses API is a beta research mode: one request
launches a leader and specialist agents inside that request. Server-side tool outputs
are not returned to the caller. It is not Grok Bot, and it is not a workforce you can
leave running.

Deferred completions (`GET /v1/chat/deferred-completion/{request_id}`) poll one model
request. They are not agent jobs.

A third-party package advertising a local Grok Bot gateway (`GET /events`) is not an
xAI or Cursor API. This design does not use it.

### 3.3 The one real observation feed

Cursor Enterprise can push OTLP/HTTP **protobuf** logs and metrics to a collector the
team runs. Grok Bot action logs are the family `grok_bot_agent_actions`. They flow
only after an admin enables **Action Recording** on the Grok Bot dashboard page.
Privacy Mode (Legacy) forces recording off. Personal bots with no team are skipped.

Documented log events (wire reference, 2026-10-02):

| Event | What it records | What it withholds |
| --- | --- | --- |
| `cursor.grok_bot.mcp_tool_call` | MCP tool name, server name, transport, status, duration | Arguments and results, unless tool I/O export is also on (HTTP only) |
| `cursor.grok_bot.shell_command` | Scrubbed command (≤ 8 KiB), target (`box` or `user_machine`), allow/block, exit, duration | Unredacted secrets; background commands have no exit code |
| `cursor.grok_bot.browser_navigation` | Normalized URL and optional page title | Full activity on the page |
| `cursor.grok_bot.computer_use_session` | Counts and duration of a computer-use subagent | Coordinates, typed text, screenshots |
| `cursor.grok_bot.tool_result` | Builtin tool name, outcome, duration, error category | Tool output |
| `cursor.grok_bot.tool_decision` | Who allowed or denied a call (`human`, `policy`, `hook`, `automatic`) | The card text and the classifier's rationale |
| `cursor.grok_bot.file_transfer` | Direction, target kind, outcome, byte count | Path, file name, content |
| `cursor.grok_bot.message_delivery` | Destination type, result (`sent`, `held`, `failed`). Peer bots get an opaque destination id | Body, subject, recipient names. Email addresses are never exported |
| `cursor.grok_bot.routine_run` | Routine id, run id, trigger, outcome, duration. Server-observed | Routine name, prompt, and the turn's text. Runs that pause for approval and are settled later are **not** recorded. Failures before a turn is planned are not recorded |
| `cursor.grok_bot.guardrail` | Loop detection, bot-wall, approval escalation and how the wait ended | Classifier rationale and card copy |
| `cursor.grok_bot.delegation` | Dispatch and completion of a subagent or a Cursor cloud agent: ids and outcome | Prompt and result text |
| `cursor.skill.activated` | A Bot read a skill (when Action Recording is on) | Skill body |
| `cursor.conversation.user_message` / `assistant_message` | Opt-in, scrubbed text, 32 KiB | Off unless the team enables Prompts and Responses |
| `cursor.conversation.tool_io` | Opt-in HTTP MCP arguments and results, 8 KiB a side | `stdio` MCP on the computer has no tool I/O record |

Join keys the wire reference defines, and which this design keeps:

- Dedupe: `cursor.event.id`
- Bot: `cursor.conversation.id` (this **is** the Bot id)
- Turn: `cursor.grok_bot.turn.id`
- Order inside a turn: `cursor.grok_bot.event.sequence` (not dense; absent on older clients)
- One tool call: `cursor.grok_bot.tool_call.id`
- Subagent rollup: `cursor.grok_bot.subagent.id` and `cursor.grok_bot.root_turn.id`
- Peer handoff: `message_delivery.destination_type=agent` plus `destination_id`
- Member: resource attributes `cursor.user.account_id` and `cursor.user.email`

Delivery contract, from the same document:

- Logs are **at-least-once**. Dedupe on `cursor.event.id`.
- Transient collector failures are retried for about **7 days**. A persistent 4xx is
  not replayed.
- **No ordering guarantee.**
- No backfill from before the destination was enabled. Upstream retention is about
  **7 days**.
- There is no OpenTelemetry `trace_id`. Correlation is the cursor ids above.
- Provenance `server` was observed by Cursor. Provenance `client` is best-effort and
  can be skipped. Correlation fields on a server row can still be client-trusted.

Audit logs are a separate Enterprise stream (bot created, access changes, routines as
control-plane events). They are not the action feed. The security doc also says Grok
Bot does not ship a customer EDR feed; OTEL export is the opt-in exception, not a
default.

### 3.4 What a non-Enterprise account can do

Self-serve Teams and individual plans can message bots, install plugins/MCP, and run
routines. They cannot turn on Action Recording or OpenTelemetry Export.

The closest mechanism on those plans is operational, not platform: a skill or a
standing instruction tells the Bot to POST a structured note to Freedom OS, or to
call an MCP tool Freedom OS hosts. The Bot may omit it, delay it, or phrase it wrong.
Network policy on Enterprise can also block the destination. Treat this as an
annotation channel (§5), never as the source of truth for "what happened."

---

## 4. JARVIS / Hermes research

The prior source audit is `docs/CHIEF_GITHUB_REUSE_AUDIT.md` (OpenJarvis `5e5f5ef`,
möbius `3e1aaf5`, StovBuilds/jarvis-architecture `51735c8`, cortex-map `68db7b1`).
This phase re-reads those findings against a new rule: **those systems own their
agents; we do not.** Hermes was checked against current Nous Research public docs
and the durable-delegation work on `NousResearch/hermes-agent`. "Jarvis OS" in the
earlier audit is StovBuilds/jarvis-architecture: one unlicensed README, no code.

### What to reuse conceptually

| Source | Idea worth keeping | How it applies when Grok Bot owns execution |
| --- | --- | --- |
| OpenJarvis traces | An append-only activity record with a typed step, outcome, and correlation ids | The journal in §7. CHIEF already does this for its **own** turns. External bot activity is a second journal, not more `ChiefTrace` rows. |
| OpenJarvis events | A stable event name plus a payload, published once and consumed by projections | Ingest writes one event. Status, the briefing, and the future graph are projections. |
| möbius journals | Atomic commit of "what happened" with the checkpoint that explains it; provider-private data stays out | Ingest is idempotent and transactional. Shell text and message bodies are encrypted. Raw OTEL attributes that look like secrets are not copied into prompts. |
| möbius presentation split | The UI does not branch on internal tool names | A future constellation reads the graph projection (§9), not Cursor attribute names. |
| Jarvis OS liveness (ideas only; no license, copy nothing) | ok / stale / dead from last-seen time | `ObservedAgent` liveness is derived from `lastEventAt`. Silence is `unknown`, not `failed`. |
| cortex-map data contract | A graph is nodes, edges, and clusters supplied by the host. The renderer does not own the data | When a picture is eventually approved, a projector can target the existing room. Do not vendor cortex-map for this phase. It is not in the repo today. |
| Hermes durable delegation ledger | Persist the fact of a handoff before treating it as delivered; at-least-once; claim; ack; a missing completion stays unknown | Delegation rows are stored as dispatched and completed separately. A missing completion is in-flight or unknown, never invented success. |
| Hermes "every tool call is visible" | Observability is a log of actions, not a hidden runtime | Match it by storing the OTEL action, not by re-executing the tool. |
| Hermes profile isolation | One home, one memory, one session store per profile | One Freedom OS user sees only the Cursor member bound to that user (§10). |

CHIEF already took one Hermes idea, and only that idea: the identity slot in
ADR-0006 (a persona fact, not `SOUL.md`). That stays as CHIEF's voice. It is not
an agent runtime.

### What not to copy

These are the parts that exist because those projects **are** the workforce. Grok
Bot already owns them.

- OpenJarvis agent hierarchy, orchestrator loop, operatives, `execute_tick`,
  AgentManager, A2A `tasks/send`
- möbius gateway, resident turn task, subagent spawning, sandbox
- Hermes `AIAgent` loop, tool registry, subagent delegation, cron delivery, skill
  learning, terminal backends
- Jarvis OS coordinator, private message bus, and the 22-agent roster
- Any local "managed agent" that would tick inside Freedom OS and pretend to be
  a Grok Bot
- Grok Build's hook runner, used as if it were Grok Bot

The existing `ChiefAgent` tables are the footprint of that copied lifecycle. Leaving
them unused is the boundary.

---

## 5. Recommended bridge architecture

```
Grok Bot  (owns bots, turns, tools, routines, computer)
    │
    │  Enterprise only, server push
    │  OTLP/HTTP protobuf logs
    │  family grok_bot_agent_actions
    │  optional conversation_content
    ▼
Freedom OS ingest
    authn → member binding → dedupe on cursor.event.id
    → ActivityEvent (append-only)
    → ObservedAgent projection
    │
    │  Any plan, optional, untrusted
    │  Bot or human POST / MCP: mission, task, finding, name
    ▼
same journal, kind namespace freedom.report.*
    │
    ▼
CHIEF TurnMachine
    read-only tool: workforce picture
    model writes the briefing
    │
    ▼
Person
```

Rules:

1. Grok Bot is never imported as a runtime. There is no second orchestrator.
2. The journal is the system of record. Briefings and the future graph are
   read models.
3. The OTEL adapter is authoritative for actions it actually delivered. Absence of
   an event is not evidence the action did not happen (client provenance can skip;
   content export can be off; approval-paused routine runs are omitted).
4. The annotation adapter never overrides an OTEL action. It may attach a label,
   a mission id, or a finding the person or the Bot asserts. CHIEF calls that an
   assertion.
5. CHIEF's xAI provider stays the language model for the briefing. It is not pointed
   at Grok Bot.
6. No command API in this design. A Bot polling Freedom OS for instructions would
   be a control plane. That waits until observation has been reliable.

Vercel cannot hold an open OTLP session. The ingest is a normal HTTPS endpoint that
accepts the OTLP/HTTP request Cursor already sends (`/v1/logs`). Cursor's documented
client speaks binary protobuf, not JSON. The endpoint has to speak that. Metrics
(`/v1/metrics`) are at-most-once and carry no correlation ids; they are optional and
not required for the picture.

Non-Enterprise deployments run the same journal with only the annotation adapter.
CHIEF's answers then say the picture is self-reported.

---

## 6. Event model

Store the platform event name as it arrived (`cursor.grok_bot.tool_result`, …).
The wire reference says the surface is additive: unknown names are kept, not
rejected.

Every stored event has:

| Field | Why |
| --- | --- |
| `sourceEventId` | `cursor.event.id`. Unique. Retries collapse. |
| `kind` | The event name. Open vocabulary. |
| `occurredAt` | The record timestamp. Ordering uses this, not arrival time. |
| `ingestedAt` | When Freedom OS accepted it. |
| `agentExternalId` | `cursor.conversation.id` |
| `turnId`, `rootTurnId`, `toolCallId`, `sequence` | Nullable join keys from §3.3 |
| `provenance` | `client` or `server` |
| `coded` | Small JSON of enums and counts (outcome, tool name, destination type, duration). No free text. |
| `textCiphertext` | Only when a text field is actually present (scrubbed shell, URL, opted-in message). Encrypted. |

Annotation events use the same row shape with kinds:

- `freedom.report.agent` — display name and role for a known `agentExternalId`
- `freedom.report.work` — mission id, task id, status, blocker, one-paragraph summary
- `freedom.report.finding` — what a Bot claims it found
- `freedom.report.attention` — the Bot claims a person must act

They carry their own idempotency key, supplied by the sender. They are tagged
`trust: untrusted`. They are not promoted into `ChiefFact`.

Events this model deliberately does not invent: a heartbeat, a task-created event,
or a failure event the platform did not send. Liveness and "blocked" are
computations over the events that did arrive (§8).

The row is durable and self-contained so a future memory job can read
`(kind, agent, turn, time, coded, decrypted text, trust)` without joining back to
Grok Bot. That job is not part of this phase.

---

## 7. Internal data model

Minimum tables. Nothing else until a query cannot be answered from these.

### `WorkforceBinding`

One Freedom OS user linked to one Cursor member.

- `userId` (RLS owner)
- `cursorAccountId` when OTEL provides it
- `emailCiphertext` of the Cursor member email, used only to match an export the
  user has verified
- `mode`: `otel` or `report`
- `status`: `active` or `revoked`

Unmapped OTEL records are not inserted under a guessed user. They are counted and
dropped, or parked in an operator quarantine that no CHIEF session can read.

### `ObservedAgent`

Projection, rebuilt from events.

- `userId`, `externalId` (`cursor.conversation.id`), unique together
- `displayName`, `role` — null until an annotation says so
- `lastEventAt`, `lastTurnId`
- `liveness`: `active`, `idle`, `stale`, `unknown`
- `openWait`: true when the newest guardrail escalation for this bot has no
  matching resume, or a `tool_decision` is `held`

Deleting a Bot in Grok Bot does not emit a tombstone we can rely on. The row stays
as history and becomes `stale`.

### `ActivityEvent`

The append-only journal in §6. Unique on `(userId, sourceEventId)`.

No `Task`, `TaskRun`, `TaskDependency`, `AgentRun`, or `AgentRelationship` table
in the first slice. Those nouns are not platform objects.

- A **turn** is the set of events with one `turnId`.
- A **routine run** is the `routine_run` event plus the events of its `turnId`.
- A **handoff** is a `message_delivery` to `agent`, or a `delegation` pair joined
  on `target_id`.
- A **task** appears only when a `freedom.report.work` annotation names one.
  Until then CHIEF talks about turns, routines, and tool calls, and says it has
  no task list.

`ChiefTrace` stays the trace of CHIEF's own model calls. Mixing bot telemetry into
it would teach the learned router from another system's actions.

---

## 8. CHIEF intelligence layer

The person asks in the existing CHIEF room. TurnMachine calls one new read-only
tool, through ToolExecutor, capability `workforce:read` (a new grant; absence
denies). The tool returns a structured picture, not a log dump:

- `asOf` and `lastEventAt`
- `coverage`: `platform`, `self_report`, or `platform+report`
- `gaps[]` in plain language: content export off, no bot names, no task
  annotations, agent stale, routine-approval runs invisible
- `agents[]`: id, name if known, liveness, last turn, open wait, in-flight
  delegation
- `recent[]`: failures, denials, guardrail stops, routine errors, peer sends,
  since the requested window
- `assertions[]`: untrusted findings and work items, each with its time

The model writes the answer. The tool does not. Answers that over-claim are a
prompt bug; the picture's `gaps` are there so the model can say what it cannot see.

Question → query:

| Ask | Picture slice |
| --- | --- |
| What's happening? | All non-stale agents, open waits, in-flight delegations, last few failures |
| What changed in the last hour? | Events with `occurredAt` in the window, grouped by bot and turn |
| Which agents are active? | `liveness = active` (an event inside the active window) |
| Which are blocked? | `openWait`, plus annotations whose status is `blocked` |
| What did the research bot find? | `freedom.report.finding` for that bot, else assistant text if content export is on, else "no finding text was captured" |
| Show the flow | The graph projection in §9, or an explicit "not enough structure" |
| Where is the bottleneck? | Oldest open wait, then oldest dispatched-without-completed delegation |
| What happened while I was away? | Events since the user's previous CHIEF session end |
| Summarize what matters | Failures, waits, finished routine runs, peer handoffs, assertions. Omit successful read-only tool calls unless asked |

Active window and stale window are configuration (proposal: active ≤ 15 minutes,
idle ≤ 6 hours, then stale). They are display thresholds, not Grok Bot's state
machine. Grok Bot has no status field we can poll.

A scheduled CHIEF turn may later call the same tool and stay quiet when nothing
is in `recent` or `openWait`. That reuses ADR-0010. It is not a new loop, and it
is not in the first slice.

---

## 9. Flow-map data architecture

No renderer work in this phase. The room's particle field and the Freedom Diamond
stay as they are. The graph is a pure function of the journal so a later picture
can place nodes around that core.

Node kinds that can be built from real ids:

| Node | Identity | Status comes from |
| --- | --- | --- |
| Agent | `cursor.conversation.id` | Liveness projection |
| Turn | `turn.id` | Newest tool outcome and guardrail in that turn |
| Action | `tool_call.id` or the event id when no tool call exists | `tool_result` / `mcp_tool_call` / `shell` outcome and `tool_decision` |
| Subagent | `subagent.id` | Its own events, edge to `root_turn.id` |
| Delegate | `delegation.target_id` | Pair of dispatched / completed |
| Routine | `routine.id` | Latest `routine_run` outcome |
| Mission, Task | Only from `freedom.report.work` | The assertion's status. Never inferred silently from a shell command |

Edge kinds:

| Edge | Evidence |
| --- | --- |
| `agent --ran--> turn` | Shared bot id + turn id |
| `turn --did--> action` | Shared turn id + tool call id, ordered by `sequence` |
| `turn --spawned--> subagent` | `root_turn.id` / `subagent.id` |
| `agent --messaged--> agent` | `message_delivery` destination type `agent` |
| `agent --delegated--> delegate` | `delegation` pair |
| `routine --fired--> turn` | `routine_run.turn.id` |
| `mission --includes--> task --assigned--> agent` | Annotation only |

Progress, blockers, and errors are attributes on those nodes (open wait, outcome
`error` or `denied`, annotation status). They are not extra node types.

The graph update rule is: a new event recomputes the nodes and edges it touches.
There is no animation clock in the data model.

Cluster layout (agents beside their turns, waits called out) is a later projector
choice. cortex-map's `nodes/edges/clusters` contract can consume this projection
if a future approval says to use it. The current room can consume the same JSON.
Neither choice is made here.

---

## 10. Security

### Platform ingest (OTEL)

- Cursor pushes to one team destination. The export is **team-scoped** and includes
  every member's bots. Freedom OS is **user-scoped**. The ingest must map
  `cursor.user.account_id` / email onto a `WorkforceBinding` the Freedom OS user
  verified. Records for any other member are not written into anyone's journal.
- Verification is an explicit link in CHIEF settings (the user confirms the Cursor
  email). A matching email inside the payload is not, by itself, permission to
  attach the stream to an account.
- The collector authenticates Cursor with a bearer token Cursor is configured to
  send. Freedom OS stores only a hash of that token. Optional allowlisting of
  Cursor's published egress IPs is a supplement; the wire reference says those IPs
  are not the primary control and can change with notice.
- Respond 200 on duplicates. A 4xx on a retry is a permanent loss (Cursor will not
  replay it). Reject a single bad record inside a batch only in a way that matches
  OTLP partial success, so the good records are not dropped forever.
- Shell commands, URLs, and opted-in message text are encrypted at rest and treated
  as untrusted content (the same injection posture CHIEF already uses for tool
  output). They never enter the system prompt except as data inside the picture
  tool result, which is already untrusted-tool-shaped.
- Retention is finite. Upstream keeps about 7 days plus a 90-day Action Recording
  store we cannot read except through export. Freedom OS should not keep shell text
  longer than the briefing needs. Coded outcomes can live longer than command text.

### Annotation ingest

- A per-user ingest key, created in CHIEF, stored hashed, rotatable, revocable.
  The request body cannot choose `userId`.
- The key will sit in a Bot skill or MCP header on the shared Grok computer, so
  every Bot on that member's computer can use it. That matches Grok Bot's own
  rule: the computer is not a per-bot security boundary. The key grants report
  rights only, not chat, not finance, not Freedom Financial.
- Body size cap, rate limit, schema check. Unknown fields dropped.
- Reports do not create `ChiefFact` rows and do not grant capabilities.

### CHIEF reads

- `workforce:read` is off until granted. The tool runs as the signed-in user under
  existing RLS.
- Briefings do not include another user's bots, the ingest bearer, or the raw OTLP
  payload.

### Cross-system credentials

Freedom OS does not store a Cursor session, a Grok Bot password, or an xAI key for
the purpose of watching bots. The xAI key CHIEF already has stays limited to model
calls.

---

## 11. Reliability

| Condition | What the platform does | What CHIEF should do |
| --- | --- | --- |
| Grok / Cursor export unavailable | No new logs | Keep the last picture. Liveness decays to stale. The briefing says the last event time. |
| Delivery fails | Cursor retries logs about 7 days. Persistent 4xx is dropped | Ingest is idempotent and returns success for duplicates and for already-stored ids. Do not 4xx a well-formed duplicate. |
| A Bot disappears | No tombstone we can depend on | After the stale window, liveness is `stale`. History remains. |
| Duplicate events | At-least-once; delegations can repeat | Unique `sourceEventId`. |
| Out of order | Explicitly unordered. A long shell command is written at settle time with the issue timestamp. Sequence resumes after an approval wait and is not dense | Sort by `occurredAt`, then `sequence` within a turn. Late events revise the projection. |
| A task runs for hours | Actions append as they settle; there is no progress percentage | The turn is in flight while events continue and no terminal routine/delegation completion has arrived. Do not mark it failed for duration alone. |
| A Bot fails | `tool_result` `error`, `routine_run` `error`, `delegation` `error`, `api.error` | Surface those. A missing completion is unknown, not success (Hermes ledger lesson). |
| Freedom OS is down | Cursor retries the OTEL POST for about 7 days | When it returns, the replay fills the journal. Annotation posts during the outage are lost unless the Bot retries with the same idempotency key; the skill text should say to retry. |
| Approval-paused routine | Documented gap: that run is not recorded | Do not invent the run. An open `tool_decision` / guardrail pause is the signal that exists. |
| Content export off | Actions still arrive, text does not | Briefings describe actions and say findings were not captured. |
| Client-provenance skip | Server rows still arrive for some events; others can vanish | Prefer `server` provenance when both exist. Never claim completeness. |

---

## 12. Implementation phases

Each phase is inert until you approve it. None of them create an agent runtime,
a flow-map UI, or memory extraction.

### Phase A — Journal and one Bot

Smallest path from nothing to "CHIEF can see one Grok agent."

- `WorkforceBinding`, `ObservedAgent`, `ActivityEvent`
- One ingest:
  - If this deployment has Cursor Enterprise, Action Recording, and a collector
    URL: the OTEL `/v1/logs` adapter, filtered to `cursor.surface=grok_bot`, one
    verified member
  - Otherwise: the annotation endpoint only, and CHIEF says the picture is
    self-reported
- One read-only tool: the picture for that binding
- Ask "what's that bot doing?" in the current room
- No graph, no scheduler change, no `ChiefAgent` writes

Exit: one bound member, one bot id, events deduped, a briefing that cites `asOf`
and the gaps.

### Phase B — The workforce

- Many bots on the same binding (every `conversation.id` in the stream)
- Liveness windows, open waits, in-flight delegations, peer handoffs
- The other question shapes in §8, still one tool
- Stale sweep can be a pass at the end of the existing chief cron tick. It only
  updates `ObservedAgent.liveness`

Exit: "which bots are active / waiting / failed" answered from the journal.

### Phase C — Status reports worth reading

- Group events into turns and routine runs inside the picture
- Include `freedom.report.*` assertions when present, labeled as assertions
- Quiet scheduled briefing only after the interactive answers are right, reusing
  the existing quiet-turn rule
- Still no notification fan-out

Exit: "what changed while I was away" and "summarize what matters" without a raw
log.

### Phase D — Flow-map data, still no picture

- A pure function from the journal to the nodes and edges in §9
- An internal query or a read-only tool result the model can describe in words
- Fixture tests: one mission annotation, two bots, a handoff, a blocked tool call
- The room canvas is unchanged

Exit: CHIEF can describe the flow. It does not draw it yet.

### Later, only after the picture is trustworthy

- A constellation drawn around the existing room core, from the Phase D JSON
- A memory consumer of `ActivityEvent`
- An evaluation of CHIEF → Grok Bot commands. That needs a real submit API or an
  explicit decision to use a Bot-polled inbox. Neither exists as a trivial option
  today

---

## Appendix — xAI OpenAPI paths verified

`GET https://docs.x.ai/openapi.json` on 2026-10-02 returned these 38 paths and no
others:

`/v1/api-key`, `/v1/chat/completions`, `/v1/chat/deferred-completion/{request_id}`,
`/v1/complete`, `/v1/completions`, `/v1/documents/search`, `/v1/embedding-models`,
`/v1/embedding-models/{model_id}`, `/v1/embeddings`, `/v1/files`,
`/v1/files/{file_id}`, `/v1/files/{file_id}/content`,
`/v1/files/{file_id}/public-url`, `/v1/files/{file_id}/public-url/revoke`,
`/v1/image-generation-models`, `/v1/image-generation-models/{model_id}`,
`/v1/images/edits`, `/v1/images/generations`, `/v1/language-models`,
`/v1/language-models/{model_id}`, `/v1/me`, `/v1/messages`, `/v1/models`,
`/v1/models/{model_id}`, `/v1/responses`, `/v1/responses/compact`,
`/v1/responses/{response_id}`, `/v1/responses/{response_id}/input_items`,
`/v1/skills`, `/v1/skills/{skill_id}`, `/v1/skills/{skill_id}/content`,
`/v1/tokenize-text`, `/v1/video-generation-models`,
`/v1/video-generation-models/{model_id}`, `/v1/videos/edits`,
`/v1/videos/extensions`, `/v1/videos/generations`, `/v1/videos/{request_id}`.

No bot, agent-roster, task, webhook, or event-subscription path.

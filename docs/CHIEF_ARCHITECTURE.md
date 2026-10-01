# CHIEF — Final Architecture and Implementation Sequence (Module 03)

> CHIEF is the current Freedom OS AI layer. Module 01 (CEO Agents / Freedom
> Brain) has been retired and is not a peer system. Isolation rules that name
> those paths still apply: CHIEF must not import or recreate that platform.
> Freedom Financial remains separate, and CHIEF's access to it stays read-only.

Status: design record. CHIEF now ships in this repository. Companion document:
[CHIEF_GITHUB_REUSE_AUDIT.md](./CHIEF_GITHUB_REUSE_AUDIT.md) (the approved audit; commit-pinned
source findings and classifications referenced throughout as "audit §N").

Governing objective: **compose and integrate existing proven work — do not reinvent it.**
For every major component this document answers: _why are we building this instead of
reusing/adapting something that already exists?_

Absolute constraints honored throughout:

- Module 01 and Module 02 are not part of CHIEF: no imports, no dependencies, no modifications,
  no architectural derivation (§4 dependency boundaries make this mechanically enforceable).
- cortex-map is REUSE DIRECTLY: vendored as-is under a third-party boundary (§8).
- OpenJarvis reuse is prioritized before building equivalents (§6 sourcing rule, §7.1).
- möbius durable-turn/approval/checkpoint/subagent semantics are adapted, not paralleled (§7.2).
- PORT/ADAPT preserves original semantics; deviations are documented inline (§10 ledger).
- REFERENCE ONLY material is never represented as reusable implementation.
- BUILD NEW always carries a documented reason (§10.4).

---

## 1. Architecture overview

CHIEF is a TypeScript control plane that runs inside Freedom OS's existing Vercel + Postgres
deployment. Its internals are ports of the two strongest audited implementations — OpenJarvis
primitives (registries, agents, tools, memory, routing, traces, events, scheduling) and möbius
durability semantics (turn state machine, checkpoints, approvals, protocol) — persisted in
Postgres via Prisma. Heavy capabilities beyond the serverless envelope are not rebuilt: they are
obtained by **wrapping the OpenJarvis server** as an optional sidecar reached through CHIEF's
provider/tool boundary. The Command Center UI reuses the vendored cortex-map renderer for the
3D memory/knowledge map.

```
                        FREEDOM OS (Vercel + Postgres + Firebase auth)
 ┌────────────────┬─────────────────┬──────────────────────────────────────────────────┐
 │   MODULE 01    │    MODULE 02    │              MODULE 03 — CHIEF                   │
 │  (untouched,   │   (untouched,   │                                                  │
 │   no imports)  │    no imports)  │  ┌────────────────────────────────────────────┐  │
 └────────────────┴─────────────────┘  │ COMMAND CENTER UI (src/components/chief)   │  │
                                       │  panels: status/agents/tasks/approvals/    │  │
                                       │  traces/memory · SSE live feed             │  │
                                       │  3D map: vendored cortex-map               │  │
                                       │  (src/third_party/cortex-map, MIT, as-is)  │  │
                                       └──────────────────┬─────────────────────────┘  │
                                                          │ HTTPS + Firebase bearer     │
                                                          │ POST ops / SSE events       │
                                       ┌──────────────────▼─────────────────────────┐  │
                                       │ CHIEF API (api/chief/*, api/cron/chief-*)  │  │
                                       │ [BUILD NEW: thin serverless shell]         │  │
                                       └──────────────────┬─────────────────────────┘  │
                                       ┌──────────────────▼─────────────────────────┐  │
                                       │ CHIEF CORE (server/chief)                  │  │
                                       │                                            │  │
                                       │ runtime/   turn state machine, checkpoints,│  │
                                       │            approvals      [PORT: möbius]   │  │
                                       │ agents/    Base→ToolUsing→Orchestrator/    │  │
                                       │            Operative  [PORT: OpenJarvis]   │  │
                                       │ tools/     ToolSpec+Executor gate pipeline │  │
                                       │            [PORT: OpenJarvis] + MCP        │  │
                                       │            [REUSE: official TS SDK]        │  │
                                       │ memory/    facts+trust tiers, FTS+pgvector │  │
                                       │            +RRF, knowledge graph           │  │
                                       │            [PORT: OpenJarvis]              │  │
                                       │ models/    engine layer [REUSE: AI SDK] +  │  │
                                       │            HeuristicRouter [PORT: OpenJ.]  │  │
                                       │ traces/    trace store + collector         │  │
                                       │            [PORT: OpenJarvis]              │  │
                                       │ scheduler/ once/interval/cron tasks        │  │
                                       │            [PORT: OpenJarvis + möbius]     │  │
                                       │ core/      registries, event taxonomy,     │  │
                                       │            capabilities [PORT: OpenJarvis] │  │
                                       │ protocol/  Op/EventMsg wire [PORT: möbius] │  │
                                       │ sidecar/   OpenJarvis client adapter       │  │
                                       │            [WRAP boundary]                 │  │
                                       └───────┬──────────────────┬─────────────────┘  │
                                               │ Prisma (atomic   │ HTTPS, Bearer      │
                                               │ transactions)    │ OpenAI-compatible  │
                                       ┌───────▼────────┐ ┌───────▼─────────────────┐  │
                                       │ POSTGRES       │ │ OPENJARVIS SIDECAR      │  │
                                       │ chief_* tables │ │ (optional container:    │  │
                                       │ + pgvector     │ │ Docker/Render/Fly)      │  │
                                       │ RLS + at-rest  │ │ [WRAP/INTEGRATE]        │  │
                                       │ encryption     │ │ local models, deep      │  │
                                       └────────────────┘ │ research, channels      │  │
                                                          └─────────────────────────┘  │
 Model providers: AI SDK → xAI Grok (primary) · Anthropic · OpenAI · Google ·           │
                  any OpenAI-compatible endpoint (which is how the sidecar plugs in)    │
 ────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Major components and responsibilities

Each component lists provenance (which audited implementation it comes from) and the one-line
answer to "why not reuse something that exists?".

| Component (location)                     | Responsibility                                                                                                                                                                                                                             | Provenance / reuse answer                                                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/chief/core/registry`             | Typed registries for agents, tools, memory backends, engines, policies; decorator/imperative registration, per-registry isolation                                                                                                          | PORT of OpenJarvis `core/registry.py` (~189 LOC). It IS the reuse — smallest possible faithful translation                                                                                                                          |
| `server/chief/core/events`               | Event taxonomy (~40 types incl. security events) + per-request emitter; every subsystem publishes here                                                                                                                                     | PORT of OpenJarvis `core/events.py` taxonomy verbatim; only the transport changes (in-process thread bus → per-request emitter + persisted journal) because serverless has no long-lived process                                    |
| `server/chief/core/capabilities`         | Capability RBAC (`file:read`, `network:fetch`, `memory:*`, `schedule:create`, `system:admin`, …), autonomy levels 0–4, audit logging                                                                                                       | PORT of OpenJarvis `CapabilityPolicy` + `AuditLogger`; möbius approval decisions layered on top                                                                                                                                     |
| `server/chief/protocol`                  | Frontend-neutral `Op` (message, interrupt, exec_approval, set_model, resume_session) and `EventMsg` types; JSON-over-SSE encoding; presentation separation (frontends never branch on capability names)                                    | PORT of möbius `src/protocol/`; transport changes from Noise WebSocket to SSE+POST because Freedom OS already has HTTPS + Firebase auth                                                                                             |
| `server/chief/runtime/checkpoint`        | Durable session state: checkpoint JSON, transcript deltas, execution journal, event journal, middleware state; atomic `saveWithEvents()` in one transaction; `fork()` for delegation                                                       | PORT of möbius `SqliteCheckpoint` schema v10 onto Prisma/Postgres. Only storage engine changes; table shapes and atomic-commit rule preserved                                                                                       |
| `server/chief/runtime/turn`              | The turn state machine: prepare → model step → tool authorization (Execute vs Approval) → execute → …→ completion; interrupts; stop hooks; **pending-approval suspension and resume-from-DB**                                              | PORT of möbius `continue_turn` phase machine. Deviation (documented): phases resume per HTTP invocation instead of living in a tokio task — this is the serverless adaptation, not a redesign                                       |
| `server/chief/runtime/approvals`         | `ApprovalPolicy` (ask/allow/allow_network/full_access mapped to CHIEF autonomy levels), `ReviewDecision` (approved/approved_for_session/denied/abort), sticky session approvals (SHA-256 keyed, capped)                                    | PORT of möbius `approval.rs` semantics incl. partial-batch denial and synthetic error ToolResults                                                                                                                                   |
| `server/chief/agents`                    | `BaseAgent → ToolUsingAgent → OrchestratorAgent` (function-calling loop, bounded turns, parallel tools, `before_tool_call` hook) and `OperativeAgent` (state-key model, tick execution, auto-persist)                                      | PORT of OpenJarvis agent hierarchy; model I/O delegated to `models/` (AI SDK) instead of the Python engine zoo                                                                                                                      |
| `server/chief/agents/managed`            | Product-level agent lifecycle: managed agents, tasks, messages, tick stats, rolling summary                                                                                                                                                | PORT of OpenJarvis `AgentManager`/`AgentExecutor` schema (SQLite `agents.db` → Prisma)                                                                                                                                              |
| `server/chief/tools`                     | `ToolSpec`/`BaseTool`/registry; **ToolExecutor with the exact gate order** rate limit → boundary guard → capability RBAC → taint policy → confirmation → timeout → output taint/injection scan                                             | PORT of OpenJarvis tool system. The gate order is preserved verbatim — it is the audited security invariant                                                                                                                         |
| `server/chief/tools/mcp`                 | MCP tool loading (HTTP/SSE transports)                                                                                                                                                                                                     | REUSE DIRECTLY: official `@modelcontextprotocol/sdk` (MIT). Building/porting a client would duplicate the official implementation of the same protocol OpenJarvis targets                                                           |
| `server/chief/memory`                    | Fact store with trust tiers (auto/trusted/untrusted), dedupe/caps, injection-scan-before-extract; hybrid retrieval (Postgres FTS + pgvector + Reciprocal Rank Fusion); knowledge-graph entities/relations                                  | PORT of OpenJarvis FactStore/MemoryService/hybrid backend/KG backend; storage JSONL+SQLite → Prisma + repo at-rest encryption. Consolidation job design guided by jarvis-architecture (REFERENCE)                                   |
| `server/chief/models`                    | Engine layer + provider registry + model catalog; heuristic routing (`score_complexity`, `classify_query`, 6 ordered rules); later trace-driven `LearnedRouterPolicy`                                                                      | REUSE DIRECTLY: Vercel AI SDK + `@ai-sdk/xai` (Grok primary), `@ai-sdk/anthropic`, `@ai-sdk/openai`(-compatible) as transports. PORT: OpenJarvis routing logic on top. Provider-private data never enters checkpoints (möbius rule) |
| `server/chief/traces`                    | `Trace`/`TraceStep` recording via collector subscribed to events; activity history; learning substrate                                                                                                                                     | PORT of OpenJarvis trace schema + collector pattern (SQLite WAL → Prisma)                                                                                                                                                           |
| `server/chief/scheduler`                 | Scheduled tasks (once/interval/cron), run logs, retries; due-task dispatch                                                                                                                                                                 | PORT of OpenJarvis scheduler store merged with möbius routines ("fresh conversation per run", run-status table); daemon thread → Vercel cron tick; croniter → `cron-parser` (npm, MIT)                                              |
| `server/chief/sidecar`                   | The OpenJarvis integration boundary: health/config, provider registration (OpenAI-compatible), capability adapters exposing sidecar agents as CHIEF tools                                                                                  | WRAP/INTEGRATE (audit §2.4); this module is the ONLY place that knows a sidecar exists                                                                                                                                              |
| `api/chief/*`, `api/cron/chief-dispatch` | Serverless shell: auth → load/resume → run phase(s) → atomic persist → stream SSE; cron tick for scheduler                                                                                                                                 | BUILD NEW (thin). Reason: no audited implementation targets Vercel functions + Prisma + Firebase; all logic inside the shell is ported, only the shell is new (§10.4)                                                               |
| `src/components/chief` (Command Center)  | The CHIEF spatial interface (§7.4): cortex-map scene as primary surface rendering live CHIEF state (agents/memory/tools/tasks/approvals), scene-graph projector, SSE→handle event bridge, glass HUD action panels with 3D/2D action parity | BUILD NEW (projector, bridge, panels — integration code by design, §8.4). The 3D renderer itself is NOT built — vendored cortex-map, unmodified                                                                                     |
| `src/third_party/cortex-map`             | 3D memory/knowledge map renderer                                                                                                                                                                                                           | REUSE DIRECTLY: vendored MIT source, unmodified (audit §5). Do not recreate or redesign                                                                                                                                             |

---

## 3. Capability sourcing rule

Applied to every present and future CHIEF capability, in order:

1. **REUSE DIRECTLY** — vendored source, npm package, or wrapped service already does it.
2. **WRAP/INTEGRATE** — a proven foreign-runtime implementation does it; reach it over its API
   (OpenJarvis sidecar is the standing example).
3. **PORT/ADAPT** — translate the audited implementation, preserving semantics; document any
   deviation and its CHIEF-specific reason.
4. **BUILD NEW** — only with a written justification of why 1–3 failed (recorded in §10.4 or a
   future ADR).

---

## 4. Dependency boundaries (mechanically enforced)

**`server/chief/**` may import:\*\*

- Node stdlib and npm dependencies: `ai`, `@ai-sdk/xai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`,
  `@modelcontextprotocol/sdk`, `cron-parser`, `@prisma/client`.
- Shared **platform** infrastructure only (module-agnostic, used by the whole app): Firebase
  auth verification (`server/auth/verifyAuth.js`), the Prisma client/db helpers, and the at-rest
  encryption utilities. These are Freedom OS platform facts, not Module 01/02 architecture
  (audit §11).

**`server/chief/**` must NOT import (and vice versa):\*\*

- `server/brain/**`, `server/agents/**`, `server/memory/**`, `server/capabilities/**` (Module 01
  server code), any `api/agents*` handler, or Module 01/02 UI code.

**UI boundaries:** `src/components/chief/**` may import `src/third_party/cortex-map` and global
platform CSS; it must not import `src/components/freedomOs/**` or Module 02 components. CHIEF
defines its own UI tokens.

**Shared files touched (additive-only):** `vercel.json` (one new cron entry for
`/api/cron/chief-dispatch` — Module 01's cron entry is not modified), `prisma/schema.prisma`
(new `Chief*` models only; no changes to existing models), `package.json` (new deps only),
module hub registration (one new module id + card; Module 01/02 entries untouched).

**Enforcement:** an ESLint `no-restricted-imports` rule fails the build if any file under
`server/chief/` or `src/components/chief/` imports from the forbidden paths, and if Module 01/02
paths import from CHIEF. Added in Phase 0 so the boundary is enforced before any code exists.

**Module 01/02 as external systems (later, per Module 03 spec):** if/when CHIEF needs their
data, it consumes defined **read-only interfaces** exposed as CHIEF tools behind capability
gates — the same way it would consume any external API. Not part of the core build; explicitly
out of scope until approved separately.

---

## 5. Data flows, event flows, persistence boundaries

### 5.1 One CHIEF turn (durable, resumable — the möbius semantics on serverless)

```
Client                    api/chief/chat                CHIEF runtime                    Postgres
  │  POST Op::Message  ─────►│                               │                              │
  │                          │ verifyAuth (platform)         │                              │
  │                          │──── load checkpoint ──────────┼────── SELECT chief_session ──►│
  │                          │                               │ resume rules (möbius):        │
  │                          │                               │  pending_approval? re-emit    │
  │                          │                               │  active_execution? continue   │
  │  ◄── SSE: turn_started ──│◄── events ────────────────────│                              │
  │                          │      phase: MODEL             │── AI SDK → router → provider │
  │  ◄── SSE: deltas ────────│◄── ModelEvents (normalized;   │   (Grok primary; provider-   │
  │                          │    provider-private fields    │    private data excluded)    │
  │                          │    never persisted)           │                              │
  │                          │      phase: TOOL AUTHORIZE    │ ToolExecutor gates:          │
  │                          │                               │ rate→boundary→RBAC→taint→    │
  │                          │                               │ confirm→timeout→scan         │
  │                          │        ├─ Execute ────────────│ run tools (parallel, bounded)│
  │  ◄── SSE: approval req ──│◄───────┴─ Approval ───────────│ persist pending_approval,    │
  │                          │                               │ END INVOCATION (suspend)     │
  │  POST Op::ExecApproval ─►│  (any later invocation)       │ resume → execute or deny     │
  │                          │      phase: COMPLETION        │                              │
  │                          │ atomic saveWithEvents(): checkpoint + transcript_delta +     │
  │                          │ execution_journal + event_journal  ── ONE TRANSACTION ──────►│
  │  ◄── SSE: turn_complete ─│                               │ TraceCollector → chief_trace │
```

Any Vercel function instance can serve any step: all state lives in Postgres, never in process
memory. This is the deliberate consequence of porting möbius's checkpoint design (audit §7).

### 5.2 Background flow (scheduler tick)

```
Vercel cron (new entry) → api/cron/chief-dispatch (CRON secret, timing-safe)
  → scheduler: claim due ChiefScheduledTask rows (bounded batch, at-least-once)
     ├─ operative agent ticks  (OpenJarvis execute_tick semantics: lock, run, stats, summary)
     ├─ memory extraction      (injection scan → facts w/ trust tiers)   [OpenJarvis MemoryService]
     ├─ KG consolidation       (embed → cosine-KNN auto-link → edge decay → duplicate merge)
     │                          [concept from jarvis-architecture — REFERENCE ONLY, implemented
     │                           on ported OpenJarvis KG schema]
     └─ retries / failure handling → ChiefTaskRun status rows            [möbius routine_runs]
```

### 5.3 Event flow

One taxonomy, three sinks — no parallel event systems:

1. **Emit:** every subsystem publishes typed events (OpenJarvis EventType taxonomy + möbius
   EventMsg turn/approval events) to the per-request emitter.
2. **Stream:** the API shell forwards presentation-safe events over SSE to the Command Center
   (möbius presentation-separation rule: the UI never branches on internal capability names).
3. **Persist:** events are journaled in the same transaction as the checkpoint
   (`chief_event_journal`) — the activity history is replayable after the fact.
4. **Collect:** the TraceCollector subscribes and materializes `ChiefTrace`/`ChiefTraceStep`
   rows on turn completion — the substrate for the Activity Center and, later, the learned
   router.

### 5.4 Persistence boundaries

All CHIEF state is in Postgres under `chief_`-prefixed Prisma models — no home directories, no
SQLite, no sidecar-owned state that CHIEF depends on:

| Store (Prisma models)                                                                                        | Ported from                                                                                                | Content notes                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ChiefSession`, `ChiefTranscriptDelta`, `ChiefExecutionJournal`, `ChiefEventJournal`, `ChiefMiddlewareState` | möbius checkpoint schema v10                                                                               | Atomic `saveWithEvents` transaction; `fork` support; version column on checkpoint JSON                   |
| `ChiefAgent`, `ChiefAgentTask`, `ChiefAgentMessage` (+ learning log)                                         | OpenJarvis `agents.db`                                                                                     | Managed-agent lifecycle, tick stats, rolling summary                                                     |
| `ChiefTrace`, `ChiefTraceStep`                                                                               | OpenJarvis `traces.db`                                                                                     | Steps typed route/retrieve/generate/tool_call/respond; outcome + feedback fields for learning            |
| `ChiefFact`                                                                                                  | OpenJarvis FactStore                                                                                       | Trust tier enum (auto/trusted/untrusted), importance/confidence, dedupe key, caps, **encrypted at rest** |
| `ChiefKnowledgeEntity`, `ChiefKnowledgeRelation`                                                             | OpenJarvis KG backend                                                                                      | pgvector embedding column; relation `origin` explicit/semantic (matches cortex-map's edge model)         |
| `ChiefScheduledTask`, `ChiefTaskRun`                                                                         | OpenJarvis scheduler + möbius routine_runs                                                                 | Kinds once/interval/cron; run status; retry counters                                                     |
| `ChiefApproval`, `ChiefCapabilityGrant`, `ChiefAuditLog`, `ChiefBudget`                                      | OpenJarvis ApprovalStore/RBAC + möbius decisions; budget caps concept from jarvis-architecture (REFERENCE) | Approval records with decision enum; sticky grants (hash-keyed, capped); per-run/per-period USD caps     |

Cross-cutting rules: RLS on every `chief_*` table (existing repo convention); only foreign key
into non-CHIEF tables is `User`; sensitive text columns use the platform encryption helpers;
pgvector enabled via one migration (`CREATE EXTENSION IF NOT EXISTS vector`); retention/expiry
columns on memory and journal tables so old data cannot silently stay authoritative forever.

The sidecar's own storage (its SQLite home volume) is **outside** CHIEF's persistence boundary:
CHIEF treats sidecar results like any external tool output — untrusted until it passes the
memory trust-tier gate.

### 5.5 Controlled autonomous operating loop (future capability; not built in Phase 2)

CHIEF must be able to act without a user prompt on every step. That capability is a
**controlled loop over the components already specified above**, not a second scheduler,
router, event bus, or approval system. The reuse source is the audited OpenJarvis
operative + scheduler (audit §2.1, commit `5e5f5ef`): `ScheduledTask` kinds once /
interval / cron, `execute_tick` (lock, run, tick stats, rolling summary, per-agent
`router_policy`), and the operative state key `operator:{id}:state` with auto-persist of
results. möbius supplies the approval gate, the interrupt, and "fresh conversation per
routine run". Nothing in this section is implemented by the Phase 2 model layer.

```
TRIGGERS / SCHEDULES / EVENTS          ChiefScheduledTask (once/interval/cron) claimed by
                                       api/cron/chief-dispatch; EventBus events
                                       (CHANNEL_*, MEMORY_*, SCHEDULER_*, AGENT_TICK_*)
        → PERCEPTION / MONITORING      operative tick reads authorized sources through
                                       ToolExecutor-gated tools (no private side channel)
        → MEMORY / STATE               ChiefFact / ChiefKnowledge* / operative state key /
                                       last ChiefTaskRun; trust tiers apply to anything read
        → REASONING                    the SAME model engine as a user turn:
                                       engine.resolve(instruction, { caller, urgency,
                                       routerPolicy, model }) → LanguageModel
                                       (server/chief/models; query is an instruction,
                                       not necessarily a chat message)
        → DECISION                     ported agent loop (Orchestrator / Operative).
                                       "Nothing warrants attention" is a valid decision
                                       and ends the tick without notifying.
                                       Phase 10 records that outcome as
                                       attention: false on the existing
                                       ChiefTaskRun result and sends nothing
        → CAPABILITY / POLICY CHECK    CapabilityPolicy (autonomy levels 0–4), the
                                       ToolExecutor gate order, ChiefBudget
        → APPROVAL IF REQUIRED         the same ApprovalPolicy / ReviewDecision /
                                       pending_approval suspension as an interactive turn.
                                       A scheduled suspension stays on that session
                                       (ADR-0011): the signed-in user decides, the
                                       resume keeps caller kind schedule, and the
                                       same ChiefTaskRun finishes. AWAITING_APPROVAL
                                       is not terminal, and a ONCE task stays ACTIVE
                                       until that resume ends the turn
        → ACTION / DELEGATION          authorized tools, or a subagent via checkpoint
                                       fork (later phase) — caller kind "delegation"
        → TRACE / EVENT                the same EventBus taxonomy and ChiefTrace rows.
                                       Inference events carry caller { kind, id, trigger }
                                       so a scheduled run is distinguishable from a
                                       user turn. The Constellation (§7.4) renders these
                                       events through the same SSE → flash/ignite/focus
                                       bridge; no separate visualization path
        → MEMORY / STATE UPDATE        facts and operative state written back through
                                       the trust-tier gate; ChiefTaskRun status updated
        → CONTINUE OR SLEEP            schedule a follow-up ChiefScheduledTask, or stop
                                       until the next trigger. No resident daemon
```

Autonomy constraints, all enforced by those existing components:

- **Permissioned** — capability grants and autonomy levels; uninventoried tools fail closed.
- **Auditable** — `ChiefAuditLog`, the event journal, and `caller` on inference events.
- **Interruptible** — möbius interrupt Op for turns; `abortSignal` on `generate()` for the
  model call itself.
- **Rate/budget limited** — ToolExecutor rate gate, `ChiefBudget` enforced at the model
  layer's `languageModelMiddleware` seam (before autonomy levels 3–4), router cheap-model
  tiering via the existing urgency rule.
- **Traceable** — `ChiefTrace` / `ChiefTraceStep` from the same collector as interactive turns.
- **Capable of being paused** — `CHIEF_MODELS_ENABLED=false` refuses `resolve`, `generate`,
  and `languageModel` (`ModelLayerPausedError`) for every caller. The scheduler's own
  pause (stop claiming ticks) is a Phase 5 control on top of this, not a replacement.
- **Subject to capability and approval policies** — a proactive tick has no path around
  the confirmation gate. Denied actions produce the synthetic error result, never a skip.

Phase 2's only obligation to this loop is the model contract: routing input is an arbitrary
instruction, per-call `model` / `routerPolicy` match OpenJarvis's per-agent tick override,
and `caller` is correlation metadata. The loop itself waits for the runtime (Phase 3),
tools and memory (Phase 4), and scheduler/operatives (Phase 5).

---

## 6. Communication summary (how the pieces talk)

| Path                            | Mechanism                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Command Center → CHIEF API      | HTTPS POST with Firebase bearer token; Ops as JSON (möbius Op taxonomy)                                                               |
| CHIEF API → Command Center      | SSE stream of EventMsg JSON (turn lifecycle, deltas, tool begin/end, approval requests, token counts)                                 |
| CHIEF core → Postgres           | Prisma; checkpoint saves are single transactions (atomic-commit rule from möbius)                                                     |
| CHIEF core → model providers    | Vercel AI SDK provider instances (xAI/Anthropic/OpenAI/Google); router selects per HeuristicRouter rules                              |
| CHIEF core → OpenJarvis sidecar | HTTPS + Bearer: (a) as a model provider via its OpenAI-compatible `/v1/chat/completions`; (b) as tools via capability adapters (§7.1) |
| CHIEF core → MCP servers        | `@modelcontextprotocol/sdk` over HTTP/SSE transports; tools surfaced through the ToolRegistry with `required_capabilities`            |
| Vercel cron → CHIEF scheduler   | New HTTPS endpoint guarded by timing-safe CRON secret comparison                                                                      |
| Modules 01/02 ↔ CHIEF           | None in this build. Later: read-only interfaces consumed as external tools (§4)                                                       |

---

## 7. Integration boundaries in detail

### 7.1 OpenJarvis boundary (WRAP first, then PORT — per approved constraint)

Reuse priority applied in three tiers:

- **Tier W1 — wrapped as a model provider (zero CHIEF-side invention):** an OpenJarvis
  container (its own Docker image + Render blueprint; Fly/Railway equivalent) registered in
  CHIEF's provider registry as an OpenAI-compatible endpoint. This immediately reuses its engine
  zoo (Ollama/vLLM local models, cloud engines) and any server-side agent it exposes through
  that API. Configuration: `CHIEF_SIDECAR_URL` + `CHIEF_SIDECAR_API_KEY`; feature-flagged;
  health-checked; CHIEF is fully functional without it.
- **Tier W2 — wrapped capabilities as CHIEF tools:** thin adapters in `server/chief/sidecar/`
  expose selected sidecar endpoints (`/v1/managed-agents`, deep_research, speech) as
  CHIEF `ToolSpec`s with `required_capabilities` and confirmation flags. Sidecar output enters
  CHIEF memory only through the trust-tier gate (`auto`/`untrusted` until reviewed).
- **Tier P — ported primitives (the audited PORT/ADAPT set):** registry, agent hierarchy,
  ToolExecutor pipeline, fact store, hybrid retrieval, router, traces, events, scheduler — these
  run inside CHIEF because the multi-user Postgres/serverless substrate requires it (audit
  §2.2/§2.4). Porting preserves semantics; each ported module carries a provenance header
  naming its OpenJarvis source file.

Deployment note: the sidecar is **per-deployment single-user by design** (its own state model —
audit §2.4). It is documented as an operator-provisioned option, not a hard dependency.

### 7.2 möbius boundary (PORT of semantics; no parallel implementations)

möbius code cannot execute in this stack (Rust single-owner gateway, OS sandboxes — audit §3.2),
so its boundary is a **semantic contract** CHIEF implements once, in one place:

- The turn phase machine, suspension/resume rules, and interrupt semantics live only in
  `server/chief/runtime/turn` — no second loop implementation anywhere in CHIEF.
- The checkpoint table shapes, atomic `saveWithEvents`, and `fork` live only in
  `server/chief/runtime/checkpoint`.
- Approval policy/decision semantics (incl. partial-batch denial, sticky approvals, abort) live
  only in `server/chief/runtime/approvals` and are consumed by the ToolExecutor's confirmation
  gate — the OpenJarvis gate pipeline calls the möbius-semantics approval component rather than
  having its own approval logic (this is the one designed junction of the two ports, documented
  here as required by constraint 6).
- The Op/EventMsg protocol lives only in `server/chief/protocol`.
- Subagent coordination (checkpoint fork, typed peer messages, depth/concurrency limits,
  wait/interrupt tools) is a later phase built on the same checkpoint store — not a separate
  mechanism.

Documented deviations from möbius (each with its CHIEF-specific reason): execution resumes per
HTTP invocation instead of a resident tokio task (serverless); Postgres instead of SQLite
(multi-user platform); schema evolution via Prisma migrations instead of möbius's
reject-on-mismatch policy (a hosted product cannot strand user sessions); SSE+POST instead of
Noise WebSocket (platform already provides authenticated HTTPS).

### 7.3 cortex-map boundary (REUSE DIRECTLY, vendored)

- Vendored at `src/third_party/cortex-map/` from commit `68db7b1` — source of
  `packages/cortex-map` with `LICENSE` (MIT, Jack Stovell/NoctemJack) and a `VENDORED.md`
  recording upstream URL + commit; entry added to `THIRD_PARTY_NOTICES.md`.
- **Unmodified**: customization happens exclusively through its public surface (`theme`,
  `nodes/edges/clusters`, `projection`, `lite`, `reduceMotion`, imperative handle). Any patch
  ever needed is recorded in `VENDORED.md` for upstream re-application. No redesign, no rewrite.
- CHIEF supplies data via a mapping adapter (the scene-graph projector, §7.4) — the adapter is
  CHIEF code; the renderer is not.
- Its runtime deps (`three@^0.184`, `react-force-graph-3d@^1.29`, `react-force-graph-2d@^1.29`)
  are installed from npm (MIT). `lite`/2D fallback is wired to reduced-motion and low-power
  clients from day one.
- Extension policy (constraint: extend/integrate only where necessary): first exhaust the
  public surface (data mapping, `theme`, cluster personas, imperative handle, HUD CSS vars);
  if a genuine gap remains, apply the **minimal** patch to the vendored source, recorded in
  `VENDORED.md` with upstream re-application notes. Never fork-and-diverge, never redesign.

### 7.4 Command Center: the CHIEF spatial interface (product requirement)

The Command Center is designed as a futuristic 3D AI-operating-system interface, not a
conventional dashboard with a 3D graphic attached. The cortex-map scene is the **primary
surface**, and it renders **real CHIEF state** — agents, memory, tools, tasks, approvals,
events, and their relationships — every element below maps onto capabilities that exist in the
vendored renderer today (verified against `packages/cortex-map/src/types.ts`).

**The CHIEF Constellation — state → scene projection (all via the public data contract):**

| CHIEF state (source tables)                           | cortex-map representation                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHIEF itself                                          | The single `role: "core"` node at the origin; `weight` = overall system activity                                                                                                                                                                                                                                                      |
| Agents (`ChiefAgent`, tick stats)                     | `AGENTS` cluster; each managed agent a `hub` node; active turns/tasks as `leaf` children (`parentId`); `weight` = recent activity; `lastSeenAt` = last run, so the built-in age gradient IS the liveness display (ok → stale → dead fade; concept from jarvis-architecture, REFERENCE ONLY, realized by an existing renderer feature) |
| Memory (`ChiefKnowledgeEntity/Relation`, `ChiefFact`) | `MEMORY` cluster; entities as nodes (high-degree entities promoted to `hub`/`subhub`); relations as edges with `origin: explicit \| semantic` — cortex-map's native use case, unchanged                                                                                                                                               |
| Tools (`ToolRegistry`, `ChiefTrace` usage)            | `TOOLS` cluster; registered tools as nodes; agent→tool edges from recent traces, `strength` = usage frequency (strong edges join the bright "thinking" tier)                                                                                                                                                                          |
| Scheduled work (`ChiefScheduledTask`, `ChiefTaskRun`) | `TASKS` cluster; tasks as nodes, recent runs as leaves; failures raise `weight` (bigger, brighter = needs attention)                                                                                                                                                                                                                  |
| Approvals (`ChiefApproval`)                           | `APPROVALS` cluster; pending approvals as high-`weight` nodes, flashed on arrival; resolving removes them                                                                                                                                                                                                                             |
| Providers/sidecar (`models/`, `sidecar/` health)      | `INTELLIGENCE` cluster; provider + sidecar nodes; `lastSeenAt` = last successful call                                                                                                                                                                                                                                                 |

Cluster definitions use angular placement to encode meaning (memory beside tools, approvals
beside agents) and per-cluster `persona.volatility` so the AGENTS zone visibly "storms" under
heavy activity — an existing knob, not new rendering code.

**Live events → the imperative handle (the SSE bridge):** the same EventMsg stream that feeds
the journals drives the scene: tool/turn events `flash()` the involved agent, tool, and session
nodes; delegation and multi-agent turns `ignite()` the propagation path; a new approval request
flashes its node and raises a HUD badge; memory writes flash the new entities. Selecting an
event in the activity feed calls `focus(id)` to fly the camera to the responsible node.

**Interaction is the interface, not decoration:** `onNodeSelect` (which hands back the node's
`data` payload) opens a contextual action panel for that entity — approve/deny for approvals,
run/pause/inspect for agents, open-trace for runs, reinforce/expire/edit for memories, edit
schedule for tasks. The built-in `⌘K` search spans all projected CHIEF state. Glass HUD panels
(status, approvals inbox, activity/trace feed, memory browser) surround the stage, themed via
cortex-map's HUD CSS variables plus CHIEF's own dark command-center tokens on the existing
Freedom OS dark-navy palette.

**Usability guardrails (explicit, per the requirement):**

- **Action parity rule:** every action reachable through the 3D scene is also reachable through
  a 2D panel — the scene is an accelerator, never the only path.
- `lite` / `reduceMotion` (built-in) swap to the 2D canvas renderer with identical data and full
  panel functionality — mobile and low-power clients get a complete interface.
- Information density is managed with cluster filtering and the projector's node budget (stay
  inside cortex-map's verified comfort band of a few hundred to ~2k nodes; older leaves collapse
  into their hubs before the budget is exceeded).
- No gameplay gimmicks: bloom/fog/tone-mapping stay within the vendored theme's restrained
  defaults; readability wins every conflict.

**What this adds to the build ledger (§8.4):** a scene-graph projector (CHIEF state → cortex-map
`nodes/edges/clusters` JSON) and the SSE→handle event bridge. Both are CHIEF-side integration
code that cortex-map is explicitly designed to receive ("bring your own graph") — the renderer
itself is not modified.

---

## 8. Reuse ledger (single source of truth)

### 8.1 REUSE DIRECTLY

| Artifact                                           | Form                            | Used for                                    |
| -------------------------------------------------- | ------------------------------- | ------------------------------------------- |
| cortex-map (`68db7b1`)                             | Vendored MIT source, unmodified | Command Center 3D memory/knowledge map      |
| `three`, `react-force-graph-3d`/`-2d`              | npm (MIT)                       | cortex-map runtime deps                     |
| Vercel AI SDK + `@ai-sdk/xai`/`anthropic`/`openai` | npm (Apache-2.0)                | Model transports (Grok primary)             |
| `@modelcontextprotocol/sdk`                        | npm (MIT)                       | MCP tool client                             |
| `cron-parser`                                      | npm (MIT)                       | Cron expression parsing (replaces croniter) |

### 8.2 WRAP/INTEGRATE

| System                     | Boundary                                                                    | Notes                                                     |
| -------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| OpenJarvis server (Docker) | `server/chief/sidecar/` — OpenAI-compatible provider + tool adapters (§7.1) | Optional, feature-flagged, per-deployment; health-checked |

### 8.3 PORT/ADAPT (semantics preserved; provenance headers on every ported module)

From OpenJarvis (`5e5f5ef`): registry pattern; BaseAgent/ToolUsingAgent/Orchestrator loop
(+`before_tool_call`); Operative state-key/tick model + Monitor strategy axes; AgentManager/
Executor lifecycle schema; ToolSpec/BaseTool/ToolRegistry; **ToolExecutor gate order**; FactStore
trust tiers + MemoryService extraction (injection-scan first); hybrid retrieval with RRF; KG
entity/relation schema; HeuristicRouter + `score_complexity` + `classify_query`;
LearnedRouterPolicy (deferred phase); Trace/TraceStep schema + collector; EventType taxonomy;
scheduler kinds + run-log schema; CapabilityPolicy RBAC + ApprovalStore + AuditLogger shapes.

From möbius (`3e1aaf5`): turn phase machine with pending-approval suspension; checkpoint schema

- atomic save + fork; ApprovalPolicy/ReviewDecision/sticky approvals/deny-and-abort semantics;
  Op/EventMsg protocol + presentation separation; reduced middleware hook set (prompt_section,
  tool_exposure, pre/post_tool_use, turn_end); subagent coordination model (later phase);
  "provider-private data never in checkpoints" rule.

### 8.4 BUILD NEW — with documented reasons (constraint 8)

| New component                                                               | Why no audited implementation could be reused/adapted                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Serverless API shell (`api/chief/*`, SSE handlers, cron endpoint)           | No audited system targets Vercel functions: OpenJarvis's shell is FastAPI+daemon threads; möbius's is a resident Rust gateway. The shell contains no domain logic — every decision it executes is ported code. (~thin glue by design)                                          |
| Prisma persistence adapters behind ported store interfaces                  | The audited stores are SQLite/JSONL single-user implementations; the _schemas_ are ported (§5.4), but the Postgres/RLS/encryption adapter code is necessarily specific to this platform                                                                                        |
| Scene-graph projector (CHIEF state → cortex-map nodes/edges/clusters, §7.4) | By design: cortex-map is "bring your own graph"; the projector is the intended integration surface, not a gap in reuse                                                                                                                                                         |
| SSE→handle event bridge (EventMsg → `flash/ignite/focus`, §7.4)             | The renderer exposes the imperative handle exactly for external drivers; binding CHIEF's event taxonomy to it is CHIEF-specific integration code                                                                                                                               |
| Command Center HUD panels                                                   | UI composition against Freedom OS's own design language; the audited UIs (OpenJarvis React app, möbius TUI) serve different products. The one substantial visualization (3D scene) IS reused unmodified. OpenJarvis's agents/traces/approvals screens are used as UX reference |
| Module 01/02 read-only interface adapters (deferred)                        | Freedom-OS-specific by definition; consumed as external tools per §4; out of scope until separately approved                                                                                                                                                                   |

Anything not listed here is not being built new. If implementation surfaces a genuine new-build
need, it gets an ADR with this same justification before code.

---

## 9. Implementation sequence

Each phase is a separately reviewable PR with its own tests; a phase does not start until the
previous one is merged or explicitly waived. Verification per repo policy: `npm run lint`,
`npm test`, `npm run build`.

- **Phase 0 — Guardrails and provenance (no behavior).** ESLint import-boundary rules (§4);
  `THIRD_PARTY_NOTICES.md` (OpenJarvis Apache-2.0, möbius Apache-2.0 + its Codex/Ratatui NOTICE,
  cortex-map MIT, npm deps); ADR template; this document merged as the reference architecture.
- **Phase 1 — Core ports + schema.** Prisma migration: all `chief_*` models (§5.4) + pgvector
  extension (with FTS-only fallback if the extension cannot be enabled yet); `core/registry`,
  `core/events` (taxonomy), `core/capabilities`, `protocol/` types. Unit tests translated from
  the corresponding OpenJarvis/möbius test intents.
- **Phase 2 — Model layer.** AI SDK provider registry (xAI Grok primary, Anthropic, OpenAI(-
  compatible) — the latter is also the sidecar socket); HeuristicRouter + complexity scorer
  ports. New env: `XAI_API_KEY` (+ optional sidecar vars).
  **Budget-cap checks (`ChiefBudget`) were specified in this phase and are not dropped.**
  The approved Phase 2 scope stopped before any caller invoked a provider, so the check
  had no call site yet. It is implemented in Phase 3, still inside the model layer (the
  original architectural home — see the cost-runaway row in §10 and ADR-0003). It is not
  relocated to Phase 8, and it is not implemented only inside the turn machine: a
  turn-only check would let a later autonomous tick bypass it.
- **Phase 3 — Durable runtime (highest risk, most tests).** `ChiefBudget` enforcement at
  the model-layer seam, before `streamText` (carried from Phase 2; ADR-0003). Checkpoint
  store with atomic `saveWithEvents` + fork; turn phase machine with suspension/resume;
  approvals wired into that machine; `api/chief/chat` SSE + `api/chief/approvals`;
  resume-mid-turn and resume-pending-approval integration tests (the möbius runtime-test
  scenarios re-expressed in Node's test runner). The model step calls AI SDK `streamText`
  on the resolved `LanguageModel` only. Tool calls are authorized here and executed only
  through the `ToolExecutor` boundary; the gate pipeline itself remains Phase 4, and the
  boundary fail-closes until those gates exist. No generic AI SDK tool `execute` callback.
- **Phase 4 — Tools + memory (gate pipeline and first tools).** `ToolExecutor` runs the
  frozen gate order, fail-closed, and `gatesInstalled` is true only when every gate is
  present. `ToolSpec` classifies read versus mutation for the existing `ApprovalCoordinator`.
  Session taint is checkpoint state. Security denials write `chief_audit_log`. The first
  tools are memory read/write, explicit KG lookup/link, schedule recording, and an MCP
  invoke that the boundary guard blocks. No code-execution tool, no scheduler, no cron, and
  no provider-architecture change. Hybrid FTS+pgvector retrieval, fact extraction, and KG
  consolidation are not in this slice. Boundary mode is block-only until the Rust scanner
  patterns are ported on purpose (ADR-0004).
- **Phase 5 — Scheduler + operatives.** Task store + `api/cron/chief-dispatch` (additive
  `vercel.json` entry); operative tick agents (OpenJarvis execute_tick semantics); retries,
  failure handling, notifications. This phase is what makes the §5.5 loop run; it does
  not introduce a second scheduler. Notifications fire only when a tick decides something
  warrants attention. Delivered slice (ADR-0005): `server/chief/scheduler/` claims due
  tasks by row compare-and-swap, runs each as one `TurnMachine` turn with caller kind
  `schedule`, records `ChiefTaskRun` (including `AWAITING_APPROVAL` and `RETRYING`),
  scans the stored prompt, seeds session taint, carries `operator:{id}:state` through
  `chief_middleware_state`, and retries only spend-neutral network failures. Memory
  extraction, KG consolidation, and notifications are not in this slice.
- **Phase 6 — Context engine (delivered slice, ADR-0006).** Before the sidecar: every
  turn gets a system prompt assembled from a Hermes-style identity slot, OpenJarvis
  `inject_context` (trust-filtered, token-budgeted), RRF-ranked facts, and möbius
  compaction/handoff notes. Extraction runs after a completed turn through
  `ChiefModelEngine`. The OpenJarvis sidecar below moves back; it is optional and
  nothing later depends on it. The context engine is what memory, skills, and
  subagents attach to.
- **Phase 7 — Governed finance reads (delivered slice, ADR-0007).** Two read-only
  tools, `finance_summary` and `workspace_plan_summary`, both `finance:read`, no
  confirmation, taint `user_private`. They call the shared aggregate and workspace
  slice through `withUserContext`. The database is not a model-facing interface.
  True Cash is not recomputed. Command Center remains a later phase.
- **Phase 8 — Governed skills (delivered slice, ADR-0008).** Bundled `SKILL.md`
  procedures are indexed by `assembleSystemPrompt` and loaded by one tool,
  `skill_view`. The document names existing ToolSpecs. It is not a ToolSpec,
  not a runner, and not a grant. `TurnMachine` and `ToolExecutor` stay the
  only execution path. Routines stay `ChiefScheduledTask`.
- **Phase 9 — Turn traces (delivered slice, ADR-0009).** A collector
  subscribes to the bus for a turn `TurnMachine` already ran and writes one
  `ChiefTrace` plus allowlisted `ChiefTraceStep` rows through
  `withUserContext`. It does not store the query, the answer, or tool
  output, and it does not change routing. Learned routing, feedback, and
  trace mining stay deferred.
- **Phase 10 — Quiet scheduled turn (delivered slice, ADR-0010).** A
  scheduled run stores `attention: false` on the result object already
  passed to `finish()`. The value does not read the answer or tool output.
  A successful quiet run stays `SUCCEEDED`. No notification is sent, and
  Module 01 `Notification` is not used. A later audit is required before
  any run can raise attention and deliver it.
- **Phase 11 — Scheduled approval resume (delivered slice, ADR-0011).** A
  scheduled turn that suspended on a confirming tool stays
  `AWAITING_APPROVAL`, and a ONCE task stays `ACTIVE`. The signed-in user
  submits the decision through `/api/chief/approvals` or chat. That request
  resumes the same TurnMachine session with `callerKind: "schedule"` and
  trigger `schedule:<taskId>`, through the same `createChiefTooling` inventory
  and the same ToolExecutor gates. The same `ChiefTaskRun` then reaches
  `SUCCEEDED`, `FAILED`, `SKIPPED`, or `AWAITING_APPROVAL` again. The cron
  tick does not resume it, does not approve it, and does not move
  `nextRunAt`. `attention` stays `false`. No new scheduler, runtime, or
  approval store.
- **Phase 12 — Schedule lifecycle (delivered slice, ADR-0012).** Four tools
  on the existing schedule store: `schedule_list` (read), and confirming
  `schedule_pause`, `schedule_resume`, and `schedule_cancel`. They use
  `schedule:create` and `withUserContext`. Pause and cancel do not claim a
  task, do not start a turn, and do not abort one that is already running.
  Resume sets `nextRunAt` with `initialNextRun` and does not call the tick.
  `attention` stays `false`.
- **Phase 13 — Schedule run ledger (delivered slice, ADR-0013).** One read-only
  tool, `schedule_runs`, on the existing schedule store. It returns the
  caller's runs (`id`, `scheduledTaskId`, `status`, `attempts`, `startedAt`,
  `completedAt`), newest first, at most 10. An optional `taskId` is not found
  when the task is not the caller's. It does not decrypt `resultCiphertext`,
  does not return errors or session ids, and does not deliver or notify.
  `attention` stays `false`.
- **Phase 14 — Schedule update (delivered slice, ADR-0014).** One confirming
  tool, `schedule_update`, on the existing schedule store. It edits the
  caller's task definition through `normalizeSchedule` and does not change
  status, id, or `agentId`. An `ACTIVE` task gets a new `nextRunAt` from
  `initialNextRun`. A `PAUSED` task keeps `nextRunAt` for `schedule_resume`.
  A locked task, or one with an `AWAITING_APPROVAL` run, is not written.
  The tool does not call the tick or start a turn. `attention` stays `false`.
- **Phase 15 — Schedule outcome (delivered slice, ADR-0015).** One read-only
  tool, `schedule_outcome`, on the existing schedule store. It returns one
  caller-owned run: the six ledger fields, `result.summary` (1,000 characters,
  injection-scanned), and the stored error when that scan allows it. Open
  runs return `summary: null`. A fenced summary is withheld. It does not
  return the session, the prompt, tool output, or ciphertext, and it does
  not run a task. `schedule_runs` stays metadata-only. `attention` stays
  `false`.
- **Phase 16 — Default capability baseline (delivered slice, ADR-0016).**
  `loadCapabilityPolicy` grants `_default` `memory:read`, `memory:write`,
  `schedule:create`, `finance:read`, and `skill:read` when the caller has
  zero `chief_capability_grant` rows. `defaultDeny` stays true. Any explicit
  row replaces that baseline. A load failure stays deny-all. Confirmation,
  the boundary guard, and the scheduler are unchanged.
- **Phase 17 — Session history (delivered slice, ADR-0017).** `GET /api/chief/history`
  returns one caller-owned interactive transcript from the existing checkpoint.
  Messages are `role` and scanned `text`. A fenced message withholds its text.
  Another user's session and a scheduled session (`origin: schedule`) are
  `session not found`. The read does not write, list sessions, or open a
  scheduled run.
- **Conversation lifecycle — session discovery (delivered slice, ADR-0018).**
  `GET /api/chief/sessions` lists the caller's interactive `ChiefSession` rows:
  `sessionId`, existing `title` (null when unset), `createdAt`, and `updatedAt`,
  newest activity first. `context.origin === "schedule"` is excluded without
  decrypting the checkpoint. A new conversation is still
  `POST /api/chief/chat` with no `session_id`. Opening one is still Phase 17
  history, and continuing it is still chat with that `session_id`. No second
  session store, transcript store, search index, or UI.
- **Governed web search (delivered slice, ADR-0019).** One read-only tool,
  `web_search`, inventoried as `web:search`. It is local, so the boundary
  guard allows it, and it does not require confirmation. `ToolExecutor` is
  the only caller. The tool calls Brave Search at a fixed host with
  `CHIEF_BRAVE_SEARCH_API_KEY` or `BRAVE_SEARCH_API_KEY`. A missing key, or
  an HTTP 401/403, returns "web search is currently unavailable" and does not
  invent results. The CEO agent's Anthropic provider web search is not reused:
  that tool runs inside a Claude call and never enters this executor. The
  empty-grant baseline also grants `web:search`. `network:fetch` stays denied.
  No browser, login, form, or scheduled news monitor.
- **Module 02 read access (delivered slice, ADR-0020).** `finance_summary` and
  `workspace_plan_summary` stay the only Module 02 reads. Each user's
  `chief_module_access.module02Read` flag defaults to off, including when no
  row exists. The sidebar control and `module02_access_set` write that same
  row. The set tool requires confirmation and cannot grant a write. There is
  no Module 02 mutation tool.
- **Phase 6b — Sidecar boundary.** `server/chief/sidecar/` provider registration + health;
  deep_research/managed-agent tool adapters; deployment recipe doc (Docker/Render/Fly) — all
  feature-flagged and optional.
- **Phase 7 — Command Center (the spatial interface, §7.4).** 7a: vendor cortex-map (+ npm
  deps three/react-force-graph) with `VENDORED.md` + notices; scene-graph projector over the
  full constellation (agents/memory/tools/tasks/approvals/intelligence clusters); module hub
  registration for Module 03 (additive). 7b: SSE→handle event bridge (flash/ignite/focus);
  `onNodeSelect` contextual action panels with the 3D/2D action parity rule; glass HUD panels
  (status, approvals inbox, activity/trace feed, memory browser); CHIEF theme on the vendored
  theme contract; `lite`/reduced-motion 2D parity path verified.
- **Later — Hardening + learning.** RLS review across `chief_*`; audit-log surfacing; budget
  enforcement UX; LearnedRouterPolicy port once real traces exist; subagent coordination
  (checkpoint fork + peer messages) if approved; ADRs for any deviations discovered.

---

## 10. Major technical risks and mitigations

| Risk                                                                                               | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Turn durability across serverless invocation limits** (function dies mid-model-call or mid-tool) | The ported möbius design is the mitigation: checkpoint before/after every phase; journal batches atomically; resume rules re-emit pending approvals and continue active executions; tools are journaled so replays are idempotent                                                                                                                                                                                                                                  |
| **Long agent turns vs Vercel max duration**                                                        | Bounded steps per invocation; continuation via client-driven follow-up or cron-driven resume of `active_execution`; partial results streamed as they occur                                                                                                                                                                                                                                                                                                         |
| **Port-fidelity drift** (subtle semantic changes from the Rust/Python originals)                   | Provenance headers naming the source file/commit on every ported module; test intents translated from the originals' suites (möbius runtime tests, OpenJarvis executor/memory tests); deviations only with a documented reason (§7.2)                                                                                                                                                                                                                              |
| **pgvector unavailable at migration time**                                                         | Extension creation isolated in its own migration; retrieval degrades to FTS+RRF-of-one until enabled; no schema depends on vector ops except the embedding column                                                                                                                                                                                                                                                                                                  |
| **cortex-map immaturity (v0.1.0, no tests)**                                                       | Leaf UI dependency (cannot touch data/agents); vendored commit pinned; `lite`/2D fallback wired; upstream tracked via `VENDORED.md`                                                                                                                                                                                                                                                                                                                                |
| **3D interface hurts usability or performance** (density, motion, mobile, WebGL limits)            | Action parity rule (§7.4): every 3D action has a 2D path; built-in `lite`/`reduceMotion` 2D renderer with identical data; projector node budget within the renderer's verified ~2k-node comfort band (older leaves collapse into hubs); restrained theme defaults — readability wins every conflict                                                                                                                                                                |
| **Sidecar operational burden / single-user state model**                                           | Optional + feature-flagged; CHIEF fully functional without it; sidecar output passes the memory trust-tier gate; per-deployment provisioning documented, never assumed                                                                                                                                                                                                                                                                                             |
| **Prompt injection / memory poisoning**                                                            | Ported OpenJarvis defenses: injection scan before extraction; trust tiers with no silent promotion; ToolExecutor output taint detection; approval gates fail closed (denied ⇒ synthetic error result, never silent skip)                                                                                                                                                                                                                                           |
| **Cost runaway from autonomous/background execution**                                              | `ChiefBudget` caps (per-run/per-period) enforced in the model layer before `streamText` / `generateText` (Phase 3, carried from the Phase 2 ledger — ADR-0003), so a later autonomous tick cannot bypass the turn machine; `CHIEF_MODELS_ENABLED=false` pauses every caller (§5.5); cheap-model tiering via the router's existing urgency rule. A missing `chief_budget` row means no cap is configured. Autonomy levels 3–4 stay off until they share this check. |
| **Cross-module contamination** (accidental coupling to Module 01/02)                               | ESLint import-boundary rules from Phase 0; `chief_*` table namespace with only-`User` FKs; additive-only touches to shared files; PR review checklist item                                                                                                                                                                                                                                                                                                         |
| **Schema evolution of checkpoints**                                                                | Version column on checkpoint JSON + Prisma migrations (documented deviation from möbius reject-on-mismatch, §7.2)                                                                                                                                                                                                                                                                                                                                                  |
| **Licensing hygiene**                                                                              | Phase 0 delivers `THIRD_PARTY_NOTICES.md` before any ported/vendored code lands; Apache-2.0 attribution headers on ported modules; möbius NOTICE propagated; nothing copied from the unlicensed jarvis-architecture repo                                                                                                                                                                                                                                           |

---

## 11. Approval requested

1. The architecture, boundaries, and flows (§1–§7), including the Command Center spatial
   interface design (§7.4: cortex-map scene as the primary interface to live CHIEF state, with
   the action-parity usability guardrails).
2. The reuse ledger, including the BUILD NEW items and their justifications (§8).
3. The phase sequence (§9) — implementation would begin with Phase 0 (guardrails/notices only)
   and pause for review at each phase boundary.

No production code will be written until this document is approved.

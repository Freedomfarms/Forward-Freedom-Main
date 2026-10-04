# CHIEF — GitHub Reuse Audit (Module 03 research deliverable)

Status: research complete, awaiting approval. No CHIEF code has been written. CEO Agents and
Freedom Financial are untouched and are **not** used as an architectural foundation anywhere in this
document.

This audit answers one question: **what proven open-source implementation can CHIEF bring in so
we do not reinvent it?** Every important component found in the four target repositories is
classified into exactly one of:

- **REUSE DIRECTLY** — use the artifact as-is (npm dependency or vendored source).
- **PORT/ADAPT** — translate the actual implementation (algorithms, schemas, state machines,
  gate order) to TypeScript/Postgres, preserving its semantics.
- **WRAP/INTEGRATE** — run the foreign-language system as a separate service and talk to it
  over its API.
- **REFERENCE ONLY** — study the design; do not carry code or schemas.
- **BUILD NEW** — no adequate open implementation found.

---

## 1. Repositories and versions inspected

All four repositories were cloned and read at source level (not README level). Two additional
deep audits covered ~326k LOC of Rust/Python.

| Repository                                                                          | Commit inspected                           | License                                        | Size                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------- |
| [open-jarvis/OpenJarvis](https://github.com/open-jarvis/OpenJarvis) (Stanford)      | `5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec` | Apache-2.0                                     | ~177k LOC Python + ~27k LOC Rust (17 crates), ~643 test modules |
| [citizenhicks/mobius](https://github.com/citizenhicks/mobius)                       | `3e1aaf5039f5069c3142861cb145fc0fb5521284` | Apache-2.0 (NOTICE: derived from OpenAI Codex) | ~147k LOC Rust, ~1,332 tests                                    |
| [StovBuilds/jarvis-architecture](https://github.com/StovBuilds/jarvis-architecture) | `51735c8199816062b3f36437bf07c36c9da44c1f` | **No license file** (all rights reserved)      | 1 file (README.md, ~16 KB). Zero implementation                 |
| [StovBuilds/cortex-map](https://github.com/StovBuilds/cortex-map)                   | `68db7b119258c29d434711676838d5a8bbd66ae1` | MIT                                            | ~2.8k LOC TypeScript (strict), React component                  |

Freedom OS constraints that every classification is judged against: Node 22, Vercel serverless
functions + Vercel cron (no always-on process), Postgres via Prisma (Supabase-oriented, RLS,
encryption-at-rest helpers), Firebase auth, multi-user data model.

---

## 2. OpenJarvis — source findings and classification

OpenJarvis is the strongest source of reusable implementation. It is a genuinely engineered
system (Alpha-declared, but with fail-closed security paths, cross-process locking, ~643 test
modules) organized around registries and five primitives. Its core limitation for Freedom OS is
that **every persistence and process assumption is single-user, single-machine**: SQLite + JSONL
under `~/.openjarvis`, an in-process thread EventBus, and a scheduler that requires a
long-running daemon.

### 2.1 Components discovered (key source files)

| Component           | Files                                                                                                                                                            | What it actually is                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | -------------------------------------------------- |
| Registry system     | `src/openjarvis/core/registry.py` (~189 LOC)                                                                                                                     | Generic decorator registry with per-class isolated storage; `AgentRegistry`, `ToolRegistry`, `MemoryRegistry`, `EngineRegistry`, `FactStoreRegistry`, `LearningRegistry` all derive from it                                                                                          |
| Agent hierarchy     | `src/openjarvis/agents/_stubs.py` (~510 LOC BaseAgent), `orchestrator.py` (~544), `native_react.py` (~367), `operative.py` (~328), `monitor_operative.py` (~758) | `BaseAgent → ToolUsingAgent → {Orchestrator, NativeReAct, Operative, MonitorOperative, …}`; `AgentContext(conversation, tools, memory_results, metadata)` / `AgentResult(content, tool_results, turns, metadata)`                                                                    |
| Orchestrator loop   | `agents/orchestrator.py`                                                                                                                                         | OpenAI function-calling tool loop with parallel tool execution (thread pool) and a `before_tool_call` governance hook; it routes between LLM and tools (it does not spawn sub-agents)                                                                                                |
| Operative agents    | `agents/operative.py`, `monitor_operative.py`                                                                                                                    | Persistent background agents: state under `operator:{id}:state` in a memory backend, session store with last-10-messages, auto-persist of results; Monitor adds pluggable strategies for memory extraction, observation compression, retrieval, task decomposition                   |
| Managed-agent layer | `agents/manager.py` (~872), `agents/executor.py` (~984)                                                                                                          | Product-level agent lifecycle on SQLite `agents.db`: managed agents, tasks, channel bindings, checkpoints, messages, learning log; `execute_tick(agent_id)` with concurrency lock and 16k-char rolling summary                                                                       |
| Tool system         | `tools/_stubs.py` (~657)                                                                                                                                         | `ToolSpec(name, description, parameters, category, cost/latency estimates, requires_confirmation, timeout_seconds, required_capabilities)`; `BaseTool.execute() → ToolResult`; `to_openai_function()`                                                                                |
| ToolExecutor        | `tools/` executor                                                                                                                                                | Security pipeline in fixed order: parse args → **rate limit → boundary guard → capability RBAC → taint sink policy → confirmation gate** → publish event → bounded thread pool with timeout → output taint detection → injection scan → event                                        |
| MCP client          | `src/openjarvis/mcp/` (~500 LOC)                                                                                                                                 | Protocol `2025-03-26`; stdio/HTTP/SSE/in-process transports; `MCPToolAdapter` wraps remote tools                                                                                                                                                                                     |
| Memory (facts)      | `src/openjarvis/memory/` (~900 LOC)                                                                                                                              | `FactStore` (append-only JSONL, dedupe, caps, cross-process locks) with **trust tiers: auto / trusted / untrusted**; `FactExtractor` (LLM extraction); `MemoryService` daemon triggered by `CHAT_EXCHANGE_COMPLETED` with injection-scan before extraction                           |
| Memory (retrieval)  | `src/openjarvis/tools/storage/` (~2,928 LOC)                                                                                                                     | Backends registered in `MemoryRegistry`: SQLite FTS5 (Rust-backed, default), BM25, dense embeddings, FAISS, ColBERT, **hybrid with Reciprocal Rank Fusion**, knowledge-graph (entities/relations)                                                                                    |
| Engine abstraction  | `engine/_stubs.py`, `engine/cloud.py` (~2,100)                                                                                                                   | `InferenceEngine` interface (`generate`, `stream`, `stream_full`, `list_models`, `health`); engines: Ollama, multi-provider cloud (OpenAI/Anthropic/Google/OpenRouter/DeepSeek/…), LiteLLM, NIM, plus an OpenAI-compatible factory (vLLM, SGLang, llama.cpp, MLX, LM Studio, Exo, …) |
| Routing             | `learning/routing/router.py` (~201) + complexity scorer                                                                                                          | `HeuristicRouter`: 6 ordered rules (urgency→smallest; code→code-model; low complexity→smallest; math→largest; complexity/reasoning→largest; default). `score_complexity()` and `classify_query()` are pure functions                                                                 |
| Learned routing     | `learning/`                                                                                                                                                      | `LearnedRouterPolicy`: classify query → per-class model map, updated from traces with composite score `0.6*success + 0.4*feedback`, min-samples threshold                                                                                                                            |
| Learning (training) | `learning/` (SFT/GRPO/DSPy/GEPA/ACE, spec_search)                                                                                                                | Trace-mined fine-tuning and agent-optimization loops; research-grade, GPU-dependent                                                                                                                                                                                                  |
| Traces              | `src/openjarvis/traces/`, `core/types.py`                                                                                                                        | `Trace(trace_id, query, agent, model, engine, steps, result, outcome, feedback, tokens, latency)` + `TraceStep(step_type, duration, input, output)`; SQLite WAL store + FTS; `TraceCollector` subscribes to the bus and saves on completion                                          |
| EventBus            | `core/events.py` (~212)                                                                                                                                          | In-process, thread-safe pub/sub; **taxonomy of ~40+ event types** covering inference, tools, memory, agent turns, scheduler, security (`TAINT_VIOLATION`, `CAPABILITY_DENIED`, `LOOP_GUARD_TRIGGERED`, `RATE_LIMITED`), workflow, skills                                             |
| Scheduler           | `src/openjarvis/scheduler/` (~400+)                                                                                                                              | `ScheduledTask` kinds **cron / interval / once** (croniter); background daemon thread polling 60s; SQLite store with tasks + run logs                                                                                                                                                |
| Security            | `src/openjarvis/security/`                                                                                                                                       | `CapabilityPolicy` RBAC (file:read/write, network:fetch, code:execute, memory:\*, schedule:create, system:admin), `GuardrailsEngine` (PII/secret scan on I/O), `ApprovalStore` (SQLite pending actions + permission memory), SSRF/boundary guards, `AuditLogger`                     |
| Sandbox             | `src/openjarvis/sandbox/`                                                                                                                                        | Docker/Podman `ContainerRunner` (`--network none`, mount allowlist), wasmtime runner                                                                                                                                                                                                 |
| A2A                 | `src/openjarvis/a2a/` (~496)                                                                                                                                     | Google A2A-inspired JSON-RPC 2.0 subset: AgentCard + `/.well-known/agent.json`, `tasks/send                                                                                                                                                                                          | get | cancel`, in-memory task store — thin/interop-grade |
| Server              | `src/openjarvis/server/` (~11.8k)                                                                                                                                | FastAPI: OpenAI-compatible `/v1/chat/completions` (SSE), managed agents, approvals, memory, traces, learning, webhooks, speech; Bearer auth; Docker + Render blueprint (`render.yaml`), systemd/launchd units                                                                        |
| Frontend            | `frontend/`                                                                                                                                                      | React 19 + Vite + Tailwind 4 + Zustand SPA and Tauri desktop shell for the Python backend                                                                                                                                                                                            |

### 2.2 Can OpenJarvis be the conceptual/core foundation of CHIEF?

**Yes — and this audit recommends exactly that.** The registry architecture, agent hierarchy,
ToolExecutor gate pipeline, operative/tick execution model, fact trust tiers, hybrid retrieval
with RRF, heuristic + trace-driven routing, EventType taxonomy, and Trace schema are coherent,
concretely implemented, and mostly expressed in small, pure, low-coupling units that translate
cleanly to TypeScript. CHIEF's core should be structured as a **faithful port of OpenJarvis's
primitives onto Postgres/Prisma and Vercel-compatible execution**, rather than a new invention.

What prevents using OpenJarvis _unmodified_ as CHIEF's core is not language — it is that its
process and persistence model (single-user home directory, SQLite, daemon threads, in-process
bus) contradicts Freedom OS's multi-user Postgres + serverless deployment. Those are exactly the
parts the port replaces; the algorithms, schemas, hierarchies, and security order are carried
over.

### 2.3 OpenJarvis classifications

| Component                                                                       | Classification                                                 | Why                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry pattern (`core/registry.py`)                                           | **PORT/ADAPT**                                                 | ~189 LOC, zero dependencies, defines CHIEF's plugin architecture (agents/tools/memory/engines/policies). Direct translation to a generic TS registry                                                                                                |
| `BaseAgent → ToolUsingAgent` hierarchy + `AgentContext`/`AgentResult`           | **PORT/ADAPT**                                                 | Proven interface contract for every agent type; port the class contract and lifecycle, back `run()` with the AI SDK                                                                                                                                 |
| OrchestratorAgent function-calling loop (incl. `before_tool_call` hook)         | **PORT/ADAPT**                                                 | The loop shape (bounded turns, parallel tool exec, governance hook) is the proven part; model I/O maps to AI SDK tool calling                                                                                                                       |
| NativeReActAgent (structured text protocol)                                     | **REFERENCE ONLY**                                             | Its THOUGHT/TOOL/INPUT text protocol exists to align with SFT/GRPO training; CHIEF uses native function calling                                                                                                                                     |
| Operative / MonitorOperative agents                                             | **PORT/ADAPT**                                                 | The `operator:{id}:state` state-key model, tick execution, auto-persist, and Monitor's strategy axes are the blueprint for CHIEF background agents on serverless ticks                                                                              |
| AgentManager / AgentExecutor (managed agents, tasks, checkpoints, learning log) | **PORT/ADAPT**                                                 | Product-level lifecycle schema translates from SQLite to Prisma models nearly table-for-table; `execute_tick` + concurrency lock + rolling summary carries to cron-tick execution                                                                   |
| ToolSpec / BaseTool / ToolRegistry                                              | **PORT/ADAPT**                                                 | Complete, sensible tool contract (cost/latency estimates, `requires_confirmation`, `required_capabilities`, timeouts); maps onto AI SDK tool definitions                                                                                            |
| **ToolExecutor security pipeline**                                              | **PORT/ADAPT**                                                 | Security-critical and battle-tested; CHIEF must preserve the exact gate order: rate limit → boundary guard → capability RBAC → taint policy → confirmation → timeout → output taint/injection scan                                                  |
| MCP integration                                                                 | **REUSE DIRECTLY** (official `@modelcontextprotocol/sdk`, MIT) | Porting the Python client is wasted effort; the official TypeScript SDK implements the same protocol OpenJarvis targets                                                                                                                             |
| FactStore + trust tiers + MemoryService extraction                              | **PORT/ADAPT**                                                 | Fact model with auto/trusted/untrusted tiers, dedupe, caps, and injection-scan-before-extract is CHIEF's preference/semantic memory write path, re-based on Postgres + repo encryption                                                              |
| Retrieval backends: hybrid RRF, dense, FTS                                      | **PORT/ADAPT**                                                 | Re-express as Postgres FTS + pgvector; RRF fusion is a small pure function; retrieval-scoring semantics preserved                                                                                                                                   |
| Knowledge-graph backend (entities/relations)                                    | **PORT/ADAPT**                                                 | SQLite entity/relation tables → Prisma models; becomes the data source for the cortex-map UI                                                                                                                                                        |
| `InferenceEngine` abstraction + engine zoo                                      | **REUSE DIRECTLY** (equivalent: Vercel AI SDK, Apache-2.0)     | The TS ecosystem already has the mature multi-provider abstraction (AI SDK + `@ai-sdk/xai` for Grok, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`); porting Python HTTP clients duplicates it. OpenJarvis's interface confirms the shape |
| HeuristicRouter + `score_complexity` + `classify_query`                         | **PORT/ADAPT**                                                 | ~500 LOC of pure functions with explicit rules; this is CHIEF's model-routing brain on day one                                                                                                                                                      |
| LearnedRouterPolicy (trace-driven)                                              | **PORT/ADAPT** (later phase)                                   | Small, well-defined: per-class model map + composite score from traces; port once traces accumulate                                                                                                                                                 |
| SFT / GRPO / DSPy / GEPA / spec_search                                          | **REFERENCE ONLY**                                             | Research-grade, GPU training loops; out of scope for a Vercel product                                                                                                                                                                               |
| Trace / TraceStep schema + TraceCollector                                       | **PORT/ADAPT**                                                 | The activity-history and learning substrate; SQLite WAL store → Prisma; collector subscribes to CHIEF's event emitter                                                                                                                               |
| EventBus + EventType taxonomy                                                   | **PORT/ADAPT**                                                 | Keep the taxonomy (~40 event types incl. security events) verbatim; implementation becomes a per-request in-process emitter + persisted event journal (serverless has no long-lived process)                                                        |
| Scheduler (cron/interval/once + run logs)                                       | **PORT/ADAPT**                                                 | Task kinds and store schema port to Prisma; the daemon polling thread is replaced by a Vercel cron HTTP tick (`cron-parser` npm, MIT, replaces croniter)                                                                                            |
| CapabilityPolicy RBAC + taint + ApprovalStore + AuditLogger                     | **PORT/ADAPT**                                                 | CHIEF's permission substrate; capability enum and approval-store shape port directly to Prisma                                                                                                                                                      |
| Container/Wasm sandbox                                                          | **REFERENCE ONLY**                                             | Vercel functions cannot host container/Wasm sandboxes; CHIEF v1 ships **no arbitrary code execution tools** (see §7)                                                                                                                                |
| A2A protocol layer                                                              | **REFERENCE ONLY** (v1)                                        | Thin subset, in-memory tasks. Its JSON-RPC shapes become relevant only if the sidecar option (§2.4) is exercised                                                                                                                                    |
| FastAPI server as a whole                                                       | **WRAP/INTEGRATE** (optional, not the foundation — see §2.4)   | Deployable today via Docker/Render as an OpenAI-compatible sidecar                                                                                                                                                                                  |
| React frontend / Tauri desktop                                                  | **REFERENCE ONLY**                                             | Freedom OS has its own design system; useful only as UX reference for agents/traces/approvals screens                                                                                                                                               |

### 2.4 The wrap option, assessed honestly

OpenJarvis is explicitly designed to run as a standalone HTTP service (Docker image, Render
blueprint, Bearer-auth OpenAI-compatible API, managed-agent/approval/memory/trace endpoints).
Wrapping it whole was seriously evaluated:

- **What it buys:** the full agent zoo (deep_research, operatives), MCP stdio tools, channels
  (Telegram/WhatsApp), speech, local-model engines, the learning stack — running today.
- **What it costs:** a second runtime (Python + Rust extension) on a persistent container with a
  durable volume (its SQLite/home-dir state; Render free tier disk is ephemeral); a second,
  unencrypted-by-Freedom-OS persistence domain outside Postgres/RLS; single-user state model,
  so multi-user Freedom OS would need one container per user or invasive isolation surgery; and
  a hard operational dependency for CHIEF's core loop.
- **Verdict:** **not the core foundation** for a multi-user Vercel+Postgres product, but kept as
  a **first-class, explicitly supported extension point**: CHIEF's model-provider layer can
  register any OpenAI-compatible endpoint, which is precisely OpenJarvis's front door. A
  deployment that wants OpenJarvis's heavy capabilities (local models, deep research, channels)
  points CHIEF at a sidecar container without changing CHIEF's architecture.

---

## 3. möbius — source findings and classification

möbius is a mature single-owner **durable agent runtime** (~1,332 tests; the agent core,
checkpointing, and approval flow are its strongest subsystems). It is one long-running Rust
gateway per user machine, with Noise-encrypted WebSockets, OS-level sandboxing (Bubblewrap /
Seatbelt), and SQLite persistence. Its own cloud offering runs **dedicated per-user microVMs**
— confirming that wrapping it for multi-tenant use is not intended. Its value to CHIEF is as the
best available open implementation of **durable, resumable, approval-gated agent turns** — which
is exactly what a serverless deployment needs, since every CHIEF turn must be able to suspend
(e.g. awaiting approval) and resume in a different process.

### 3.1 Components discovered (key source files)

| Component            | Files                                                                                      | What it actually is                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Turn state machine   | `src/agent/turn.rs` (~404), `turn/model.rs` (~1,344), `tool_step.rs`, `approval.rs` (~291) | Phases: prepare → model step → tool authorization (**Execute vs Approval**) → tool execution → back to model → completion, with stop hooks that can inject continuations; interrupts drain submissions mid-loop; provider-private fields never enter checkpoints                                                                                                         |
| Checkpoint store     | `src/backend/checkpoint/sqlite.rs` (~1,144)                                                | Tables: `sessions` (latest checkpoint JSON + context), `transcript_delta` (append-only model context batches), `execution_journal` (completed turns), `event_journal` (normalized frontend events), `middleware_state` (scoped opaque JSON). **Atomic `save_with_events()`** commits checkpoint + deltas + events in one transaction; `fork()` for subagents             |
| Checkpoint shape     | `Checkpoint` struct                                                                        | `context`, `context_epoch`, `compaction_count`, `total_usage`, `pending_messages`, `active_execution?`, `pending_approval?`, `execution_stats` — everything needed to resume mid-turn, including a pending approval                                                                                                                                                      |
| Resume logic         | `agent/mod.rs` `Runner::run`                                                               | On start: load checkpoint → if `pending_approval` re-emit request and wait → else continue active execution → replay journal to frontend → drain queued messages                                                                                                                                                                                                         |
| Approval system      | `src/backend/sandbox/approval.rs` (~426)                                                   | `ApprovalPolicy`: `ask` / `allow` / `allow_network` / `full_access`; wire event `ExecApprovalRequest{id, turn_id, calls, reason}`; decisions `Approved / ApprovedForSession / Denied{rejection} / Abort`; **sticky session approvals keyed by SHA-256(session, tool, args), capped at 64**; denied calls produce synthetic error ToolResults while sibling calls proceed |
| Protocol             | `src/protocol/` (~3.7k)                                                                    | Frontend-neutral `Op` (message, interrupt, exec_approval, capability_command, set_model, resume_session) and `EventMsg` (~25 types: turn lifecycle, deltas, tool begin/end, approval request, token count, compaction…), with a presentation layer so frontends never branch on capability names                                                                         |
| Middleware system    | `src/middleware/` (~27k)                                                                   | Ordered hook trait (register, prompt_section, session_start, pre_model, model_request, tool_exposure, pre_tool_use, permission_request, post_tool_use, compaction, stop, turn_end, session_end); 15 shipped capabilities (tools, compaction, scratchpad, tasks, sessions, artifacts…)                                                                                    |
| Subagents middleware | `src/middleware/subagents/` (~2.7k)                                                        | Tools `spawn_agent / send_message / list_agents / interrupt_agent / wait_agent`; spawn = reserve tree node → **fork parent checkpoint** → child agent with `AgentRole::Subagent{parent…}` and isolated sandbox → typed peer messages; depth/concurrency/retention limits from config                                                                                     |
| Model router         | `src/backend/model/`                                                                       | `Model` trait (respond/stream, compact, image gen, prompt-cache capability, pricing); 7 providers (OpenAI socket/Codex/Responses, Anthropic, DeepSeek, Kimi, OpenRouter); TOML-embedded model presets                                                                                                                                                                    |
| Routines             | `crates/mobius-gateway/src/host/routines.rs` (~335)                                        | Schedule kinds `once / interval / cron`; each run opens a fresh conversation; `routine_runs` status table; dispatched from a 15s gateway tick                                                                                                                                                                                                                            |
| Gateway              | `crates/mobius-gateway/` (~47k)                                                            | Pairing, Noise_NK channel crypto, wire protocol v86 (exact-match), 32-session caps, Cloudflare tunnel, artifacts, usage aggregates                                                                                                                                                                                                                                       |
| Sandbox              | `src/backend/sandbox/`                                                                     | `Sandbox` (authorization state machine) over `LocalSandbox` (cap-std roots) enforced by Bubblewrap (Linux) / Seatbelt (macOS); fail-closed on other platforms                                                                                                                                                                                                            |

### 3.2 möbius classifications

| Component                                                                                | Classification                    | Why                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Turn state machine** (phases, interrupt, stop hooks, pending-approval suspension)      | **PORT/ADAPT**                    | The best-tested open implementation of a durable agent turn; CHIEF ports the phase machine and suspension semantics to TS, replacing the tokio task model with resume-per-HTTP-request                                  |
| **Checkpoint schema + atomic save + fork**                                               | **PORT/ADAPT**                    | The five-table shape (session/transcript-delta/execution-journal/event-journal/middleware-state) and single-transaction commit reimplement naturally on Postgres/Prisma; `fork()` is the substrate for delegated agents |
| **Approval flow** (`ApprovalPolicy`, `ReviewDecision`, sticky approvals, deny semantics) | **PORT/ADAPT**                    | Complete, coherent approval semantics incl. partial-batch denial and turn abort — maps directly to CHIEF autonomy levels; sticky-approval hashing is a proven UX refinement                                             |
| **Op/EventMsg protocol taxonomy** + presentation separation                              | **PORT/ADAPT**                    | Becomes CHIEF's client protocol (JSON over SSE + POST instead of Noise WebSocket); the "frontends never branch on capability names" rule keeps the Command Center decoupled                                             |
| Middleware hook system                                                                   | **PORT/ADAPT** (reduced hook set) | The capability-seam idea is right; CHIEF v1 ports a minimal subset (prompt_section, tool_exposure, pre/post_tool_use, turn_end) rather than all 17 hooks                                                                |
| Subagent coordination model (checkpoint fork, peer messages, tree limits)                | **PORT/ADAPT** (later phase)      | The cleanest open design for delegation; port the coordination model onto CHIEF checkpoints, not OS process spawning                                                                                                    |
| Routines (once/interval/cron, fresh conversation per run, run-status table)              | **PORT/ADAPT**                    | Merges with the OpenJarvis scheduler port into one CHIEF task-scheduling design                                                                                                                                         |
| `Model` trait + provider transports                                                      | **REFERENCE ONLY**                | The AI SDK covers multi-provider transport in TS; möbius confirms the normalization boundary (provider-private data never in checkpoints — CHIEF adopts that rule)                                                      |
| Gateway (pairing, Noise, wire v86, tunnels)                                              | **REFERENCE ONLY**                | Single-owner desktop topology; Freedom OS already has Firebase auth + HTTPS                                                                                                                                             |
| OS sandbox (Bubblewrap/Seatbelt)                                                         | **REFERENCE ONLY**                | Impossible in Vercel functions; CHIEF keeps the _authorization_ state machine and omits code-execution tools (§7)                                                                                                       |
| Whole gateway as wrapped service                                                         | **REFERENCE ONLY**                | Verified from source: one process ≈ one user's machine (local FS, host-identity full access, 32-session caps). Their own cloud wraps it in per-user microVMs — not a fit for multi-tenant Vercel                        |

---

## 4. StovBuilds/jarvis-architecture — findings and classification

The repository contains exactly one file, `README.md`. There is **zero implementation**: no
coordinator code, no bus library (`claude-bus-lib` is named in diagrams but is private — 404 on
GitHub), no Postgres DDL (the "78 tables" exist only as a diagram label), no SSE schema, no
scheduling units, no approval code. The live 22-agent system is explicitly private; the only
open-sourced component is cortex-map (§5).

**Legal note that decides the classification:** the repo has **no license file and no license
grant in the README**. Default copyright applies — nothing may be copied from it, including
prose and diagrams. Only the uncopyrightable ideas/facts may inform design.

| Component described                                                                                                    | Implementation present?     | Classification     | Design value worth keeping (as concepts only)                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator (routing, liveness ok/stale/dead, self-healing registry)                                                   | No                          | **REFERENCE ONLY** | Fail-fast liveness classification for agent status displays                                                                                                      |
| 22 specialized agents roster                                                                                           | No                          | **REFERENCE ONLY** | A believable specialized-agent catalog (research triage with learned taste, editorial QA, security scanning cadence)                                             |
| Message bus (Discord + Postgres LISTEN/NOTIFY, HMAC-SHA256 frames)                                                     | No (library private)        | **REFERENCE ONLY** | The JSON canonicalization postmortem (sign what goes on the wire — `toJSON` first, drop `undefined`, sorted keys) is a real lesson for any signed-payload design |
| Memory + knowledge graph (pgvector, 15-min consolidation: embed → cosine-KNN auto-link → edge decay → duplicate merge) | No                          | **REFERENCE ONLY** | The consolidation pipeline shape directly informs CHIEF's knowledge-graph maintenance job                                                                        |
| Approvals (reversibility rule: read-only auto, destructive human-gated)                                                | No                          | **REFERENCE ONLY** | Matches the autonomy-level design CHIEF ports from möbius/OpenJarvis                                                                                             |
| Cost controls (hard per-run/per-month USD caps, kill switch, cheap-model triage)                                       | No                          | **REFERENCE ONLY** | CHIEF should implement budget caps as first-class config from day one                                                                                            |
| SSE dashboard, 3D map                                                                                                  | No (renderer is cortex-map) | see §5             | —                                                                                                                                                                |

---

## 5. StovBuilds/cortex-map — findings and classification

A real, working, MIT-licensed React 3D knowledge-graph renderer — the same component that renders
the private Jarvis fleet's live memory map.

### 5.1 Verified component record

Facts verified directly from `packages/cortex-map/package.json`, the repository's tags/releases,
and the npm registry (not from the README):

- **License:** MIT (declared in `package.json` `"license": "MIT"` and repo `LICENSE`,
  Copyright (c) 2026 Jack Stovell / NoctemJack).
- **Size:** ~2.8k LOC TypeScript/React (strict mode), in `packages/cortex-map/src`
  (`CortexMap.tsx` ~1,406, `scene.ts` ~850, plus layout/types/styles).
- **Stack compatibility:** React 19 + Vite confirmed — peer deps `react >= 18`, dev types React
  19.1, and the bundled `demo/` app is itself React 19 + Vite (the same stack as Freedom OS).
  ESM-only (`"type": "module"`), built with tsup, `sideEffects: false`.
- **Rendering dependencies:** `three` (^0.184.0, MIT) and `react-force-graph-3d` /
  `react-force-graph-2d` (^1.29.1, MIT). No react-three-fiber, no direct d3.
- **Tests:** none (CI runs typecheck + build only).
- **Maturity:** v0.1.0 — early version, but with strong docs (`docs/data-format.md`,
  `docs/theming.md`) and a working demo app.
- **Intended use in CHIEF:** the Command Center's 3D memory/knowledge map, fed by the
  `ChiefKnowledgeEntity` / `ChiefKnowledgeRelation` tables (§8).
- **npm publication: unverified/not found.** The package is publish-shaped (`prepublishOnly`
  build script, `files: ["dist"]`) but the registry returns 404 for `cortex-map`,
  `@stovbuilds/cortex-map`, and `@noctemjack/cortex-map`, and the repository has **no git tags
  and no GitHub releases**. Treat as unpublished source.

### 5.2 Reuse decision

**REUSE DIRECTLY — as vendored MIT source, not as an npm dependency.** "Reuse directly" here
means the existing implementation is dropped into CHIEF with minimal modification; the
distribution channel is vendoring because no published package exists:

- Vendor `packages/cortex-map` into the repo under a third-party boundary (e.g.
  `src/third_party/cortex-map/`), preserving its `LICENSE` file, copyright attribution, and an
  entry in `THIRD_PARTY_NOTICES.md`.
- Keep vendored code unmodified wherever practical (theme/props are the customization surface —
  the component is explicitly "bring your own nodes; theme everything"). Any local patches are
  documented in the vendored directory so upstream updates can be re-applied.
- Its two runtime dependencies (`three`, `react-force-graph-3d`/`-2d`) are added from npm.
- **Do not redesign or recreate cortex-map.** The existing implementation is used as-is.

Other details for integration: API is `<CortexMap nodes edges clusters theme onNodeSelect search
inspector reduceMotion lite projection />` + imperative handle `flash(ids) / ignite(ids) /
focus(id)`; node model (`id, label, cluster, type, summary, weight, role: core|hub|subhub|leaf,
parentId, lastSeenAt`) and edge model (`relation, strength, origin: explicit|semantic`) map
naturally onto a memory/knowledge graph. Rendering: WebGL via three.js, pinned layout (no live
physics), bloom/ACES post-processing, render-on-demand sleep/wake, DPR cap, and a 2D canvas
fallback for lite/reduced-motion. Comfort band: a few hundred to ~2k nodes.

| Component                       | Classification                                             | Why                                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cortex-map renderer             | **REUSE DIRECTLY** (vendored MIT source under third_party) | Purpose-built for exactly CHIEF's "living memory map" UI; drop-in for React 19 + Vite; unpublished on npm so reuse = vendoring with attribution. Mitigation for v0.1.0/no-tests: it is a leaf UI dependency — a failure cannot affect data or agents |
| `react-force-graph-3d`, `three` | **REUSE DIRECTLY** (npm, MIT)                              | Mature (force-graph suite ~3.3k–6.4k stars); installed as cortex-map's runtime deps                                                                                                                                                                  |

---

## 6. License implications (summary)

| Source                                                                | License                                                           | Obligations for CHIEF                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenJarvis                                                            | Apache-2.0                                                        | Ported/translated code is a derivative: retain attribution + license reference in file headers of ported modules; add entries to a `THIRD_PARTY_NOTICES.md`. Patent grant included. Commercial/proprietary use permitted |
| möbius                                                                | Apache-2.0, **with NOTICE (derived from OpenAI Codex / Ratatui)** | Same as above, and NOTICE contents must be propagated in `THIRD_PARTY_NOTICES.md` for any ported material. Commercial use permitted                                                                                      |
| jarvis-architecture                                                   | **None**                                                          | No copying of any kind (code, prose, diagrams). Concepts/facts only                                                                                                                                                      |
| cortex-map                                                            | MIT (npm publication not found — vendored source reuse)           | Vendor under a `third_party/` boundary with `LICENSE` + copyright line (Jack Stovell / NoctemJack) intact; note in `THIRD_PARTY_NOTICES.md`                                                                              |
| react-force-graph-3d, three, cron-parser, `@modelcontextprotocol/sdk` | MIT                                                               | Standard npm usage; notices ship in `node_modules`                                                                                                                                                                       |
| Vercel AI SDK + `@ai-sdk/*` providers                                 | Apache-2.0                                                        | Standard npm usage                                                                                                                                                                                                       |

No copyleft anywhere in the selected set; nothing blocks proprietary use of Freedom OS.

---

## 7. Node/Vercel compatibility and security implications

**Compatibility rulings (from source, not READMEs):**

- Neither OpenJarvis (FastAPI + daemon threads + SQLite home dir) nor möbius (long-running Rust
  gateway + OS sandbox) can execute inside Vercel functions. Both **can** run as external
  containers; only OpenJarvis is designed to be _called_ by third-party apps (OpenAI-compatible
  Bearer-auth API), which is why the sidecar option is retained for it (§2.4) and not for möbius.
- Everything classified PORT/ADAPT was selected because it survives serverless: pure functions
  (routing, RRF, complexity scoring), schemas (traces, checkpoints, tools, approvals), and state
  machines that suspend to the database rather than to process memory.
- The möbius checkpoint design is what makes a serverless CHIEF _possible_: a turn that hits an
  approval gate persists `pending_approval` and dies; any later invocation resumes it. This is a
  deliberate architectural consequence of the audit.

**Security implications adopted from the audited sources:**

1. **ToolExecutor gate order** (OpenJarvis): rate limit → boundary guard → capability RBAC →
   taint policy → confirmation → timeout → output taint/injection scan. Ported verbatim.
2. **Approval semantics** (möbius): fail-closed authorization before any tool executes; denied
   calls yield synthetic errors, never silent skips; abort kills the turn; sticky approvals are
   scoped and capped.
3. **Memory trust tiers** (OpenJarvis): external/untrusted content can never silently become
   trusted memory; extraction is injection-scanned first. This satisfies the Module 03 spec's
   memory-poisoning requirement with a proven design.
4. **No arbitrary code execution in CHIEF v1.** Both reference systems only allow shell/code
   tools inside OS-level sandboxes (Bubblewrap/Seatbelt/containers) that Vercel cannot provide.
   CHIEF v1 tool surface is HTTP/data/memory/scheduling tools only; a code-execution capability
   would require the sidecar route and its own audit.
5. **Provider-private data never enters checkpoints** (möbius rule), keeping persisted state
   model-agnostic and minimizing leakage.
6. Budget caps and kill switch as first-class config (jarvis-architecture concept).

---

## 8. Persistence/database implications

All ported stores re-base onto the existing Postgres via Prisma (new, namespaced tables; no
foreign keys into CEO Agents and Freedom Financial tables other than `User`):

| CHIEF store (new tables)                                                                                     | Ported from                                                              | Notes                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `ChiefSession`, `ChiefTranscriptDelta`, `ChiefExecutionJournal`, `ChiefEventJournal`, `ChiefMiddlewareState` | möbius checkpoint schema v10                                             | Atomic save via a single Prisma transaction; fork support for delegation                                   |
| `ChiefAgent`, `ChiefAgentTask`, `ChiefAgentMessage`, learning log                                            | OpenJarvis `agents.db` (AgentManager)                                    | Managed-agent lifecycle + tick stats                                                                       |
| `ChiefTrace`, `ChiefTraceStep`                                                                               | OpenJarvis `traces.db`                                                   | Activity history + learning substrate; feeds `LearnedRouterPolicy` later                                   |
| `ChiefFact`                                                                                                  | OpenJarvis FactStore                                                     | Trust tiers auto/trusted/untrusted; encrypted at rest with the repo's existing platform encryption helpers |
| `ChiefKnowledgeEntity`, `ChiefKnowledgeRelation`                                                             | OpenJarvis knowledge-graph backend                                       | Source data for cortex-map; consolidation job per jarvis-architecture concept                              |
| `ChiefScheduledTask`, `ChiefTaskRun`                                                                         | OpenJarvis scheduler store + möbius routines                             | Kinds once/interval/cron; run logs; executed by a new, separate Vercel cron endpoint                       |
| `ChiefApproval`, `ChiefCapabilityGrant`, `ChiefAuditLog`                                                     | OpenJarvis ApprovalStore/CapabilityPolicy/AuditLogger + möbius decisions | Autonomy levels 0–4 realized as capability policy + approval records                                       |
| Embeddings                                                                                                   | —                                                                        | `pgvector` extension (one `CREATE EXTENSION`; supported on Supabase) for dense retrieval + KG auto-linking |

Requirements: pgvector enabled; RLS policies on all `Chief*` tables consistent with the repo's
existing row-level security approach; retention/expiry columns on memory and journal tables.

---

## 9. What can realistically be reused vs what must be rewritten

**Reused directly (as artifacts):** cortex-map (unpublished on npm — vendored MIT source under a
`third_party/` boundary, reused as-is per §5.2) with react-force-graph-3d + three from npm;
Vercel AI SDK + `@ai-sdk/xai`/`@ai-sdk/anthropic`/(others) as the engine layer;
`@modelcontextprotocol/sdk` for MCP tools; `cron-parser` for schedule parsing.

**Ported (implementation semantics carried, storage/runtime translated):** OpenJarvis registry
pattern, agent hierarchy + orchestrator loop, operative tick model, managed-agent lifecycle
schema, ToolSpec/ToolExecutor pipeline, fact store + trust tiers + extraction service, hybrid
RRF retrieval, knowledge-graph schema, HeuristicRouter + complexity scoring (+ learned policy
later), Trace schema + collector, EventType taxonomy, scheduler schema; möbius turn state
machine, checkpoint schema + atomic commit + fork, approval flow, protocol taxonomy, reduced
middleware hooks, subagent coordination (later phase).

**Rewritten/new (no adequate open implementation for our runtime):** the serverless execution
shell (HTTP/SSE handlers that load-resume-persist turns; cron tick dispatcher), Prisma/RLS
persistence adapters behind the ported store interfaces, integration adapters that expose
CEO Agents and Freedom Financial data to CHIEF as read-only tools via public interfaces, and the Command Center UI
around cortex-map (built on the existing Freedom OS design system).

**Explicitly not built in v1:** code-execution tools/sandbox, voice, channels
(Telegram/WhatsApp), model fine-tuning loops.

---

## 10. Proposed CHIEF architecture (assembled from the strongest reusable components)

```
                       FREEDOM OS  (Vercel + Postgres)
   ┌──────────────┬──────────────────┬───────────────────────────────────┐
   │  CEO AGENTS  │FREEDOM FINANCIAL │         MODULE 03 — CHIEF         │
   │  (untouched) │   (untouched)    │                                   │
   └──────┬───────┴────────┬─────────┘                                   │
          │ read-only      │ read-only                                   │
          ▼ interfaces     ▼ interfaces                                  │
   ┌─────────────────────────────────────────────────────────────────────┐
   │ CHIEF CORE (TypeScript — OpenJarvis primitives, möbius durability)  │
   │                                                                     │
   │  Registries (agents/tools/memory/engines/policies)   [OpenJarvis]   │
   │  Agent hierarchy: Base → ToolUsing → Orchestrator/   [OpenJarvis]   │
   │    Operative(tick)                                                  │
   │  Turn runtime: phase machine, interrupts,            [möbius]       │
   │    pending-approval suspension, resume-from-DB                      │
   │  Checkpoints: session/delta/journal tables, atomic   [möbius]       │
   │    commit, fork (delegation)                                        │
   │  ToolExecutor: rate→boundary→RBAC→taint→confirm→     [OpenJarvis]   │
   │    timeout→scan   (+ MCP tools via official TS SDK)                 │
   │  Approvals & autonomy: policy, decisions, sticky     [möbius +      │
   │    grants, audit log                                  OpenJarvis]   │
   │  Memory: facts w/ trust tiers, hybrid FTS+pgvector   [OpenJarvis]   │
   │    +RRF retrieval, knowledge graph + consolidation                  │
   │  Traces & events: trace store, event taxonomy,       [OpenJarvis]   │
   │    journal → SSE activity feed                                      │
   │  Scheduler: once/interval/cron tasks + run logs,     [OpenJarvis +  │
   │    Vercel-cron tick                                   möbius]       │
   │  Model routing: HeuristicRouter port over AI SDK     [OpenJarvis +  │
   │    provider registry (Grok primary via @ai-sdk/xai,   AI SDK]       │
   │    Anthropic/OpenAI/Google/local; learned policy                    │
   │    from traces later)                                               │
   └───────────────┬─────────────────────────────────┬───────────────────┘
                   │                                 │ optional extension
                   ▼                                 ▼
   ┌───────────────────────────────┐   ┌───────────────────────────────┐
   │ COMMAND CENTER UI (Module 03) │   │ OpenAI-compatible sidecars    │
   │ cortex-map 3D memory map      │   │ e.g. wrapped OpenJarvis       │
   │ [REUSE: MIT vendored]         │   │ container (local models,      │
   │ agents/tasks/approvals/traces │   │ deep research, channels)      │
   │ panels, SSE live feed         │   │ [WRAP/INTEGRATE, per-deploy]  │
   └───────────────────────────────┘   └───────────────────────────────┘
```

Data flow for one CHIEF turn (all state in Postgres, any function instance can serve any step):
request → load checkpoint → phase machine (model step via router → tool authorization → execute
or suspend on approval) → atomic save (checkpoint + transcript delta + events) → events streamed
to the Command Center over SSE → traces recorded → facts/knowledge extracted asynchronously by a
scheduled task with injection scan and trust tiers.

## 11. Conceptual borrowings from CEO Agents: NONE

CHIEF's architecture above is derived entirely from OpenJarvis, möbius, cortex-map, and
ecosystem libraries. Specifically:

- No use or imitation of `server/brain/` (brainTurn), `server/agents/` (toolBelt, runner,
  registry), `server/memory/`, `BrainJob`, world-model, or any CEO Agents UI. CHIEF's turn loop
  is the möbius phase machine; its registries, tools, memory, traces, scheduler are OpenJarvis
  ports. No code imports from CEO Agents paths will exist under CHIEF's directories.
- Unavoidable **shared platform infrastructure** (module-agnostic, used by all modules, listed
  for full transparency): Firebase authentication verification, the Prisma/Postgres connection
  and RLS conventions, the repo's at-rest encryption utilities, and the Vercel deployment
  platform (CHIEF adds its **own separate** cron entry in `vercel.json`; additive only). These
  are Freedom OS platform facts, not CEO Agents architecture.
- CEO Agents and Freedom Financial appear in CHIEF only as **external systems** accessed through
  read-only interfaces, per the Module 03 spec.

---

## 12. Decision requested

Approve or adjust:

1. The classifications in §2–§5 (notably: OpenJarvis primitives as CHIEF's conceptual/core
   foundation via PORT/ADAPT; möbius as the durability/approval semantics source; cortex-map
   vendored for the 3D memory map; OpenJarvis sidecar as optional extension, not foundation).
2. The proposed architecture in §10 and persistence mapping in §8.
3. v1 scope exclusions in §9 (no code-execution tools, no voice/channels, no fine-tuning).

On approval, the next deliverable is the implementation plan (phasing, Prisma schema drafts,
directory layout, and the `THIRD_PARTY_NOTICES.md` scaffolding). No implementation has begun.

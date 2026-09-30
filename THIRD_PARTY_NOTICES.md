# Third-Party Notices

This file records the licenses and attribution for third-party work used by Freedom OS
Module 03 (CHIEF). The reuse decisions and their rationale are documented in
[docs/CHIEF_GITHUB_REUSE_AUDIT.md](./docs/CHIEF_GITHUB_REUSE_AUDIT.md) and
[docs/CHIEF_ARCHITECTURE.md](./docs/CHIEF_ARCHITECTURE.md).

Conventions used in this repository:

- **Ported code** (implementation semantics translated to TypeScript/JavaScript from an
  Apache-2.0 source) carries a provenance header in each ported module naming the upstream
  project, source file, and commit, and is listed in this file.
- **Vendored code** (source copied into the repository) keeps its upstream `LICENSE` file
  in its vendored directory plus a `VENDORED.md` recording the upstream URL and commit.
- Before the first ported or vendored code merges (Phase 1+), the full text of each
  applicable license is added under `licenses/` and referenced here.

---

## OpenJarvis (Stanford Scaling Intelligence Lab)

- Repository: https://github.com/open-jarvis/OpenJarvis
- Commit audited: `5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec`
- License: Apache License 2.0
- Use in this repository: **ported implementation semantics** for CHIEF (Module 03) —
  registry pattern, agent hierarchy and orchestrator loop, tool specification and executor
  gate pipeline, memory fact store with trust tiers, hybrid retrieval (Reciprocal Rank
  Fusion), knowledge-graph schema, heuristic and trace-driven model routing, trace schema
  and collector, event taxonomy, scheduler schema, capability policy and approval store
  shapes. Each ported module carries a provenance header naming the upstream source file
  and commit.
- Ported modules in this repository (Phase 1):
  - `server/chief/core/registry.js` ← `src/openjarvis/core/registry.py`
  - `server/chief/core/events.js` ← `src/openjarvis/core/events.py`
  - `server/chief/core/capabilities.js` ← `src/openjarvis/security/capabilities.py`
  - `chief_agent*`, `chief_trace*`, `chief_fact`, `chief_knowledge_*`,
    `chief_scheduled_task` Prisma models ← OpenJarvis persistence schemas
    (`prisma/migrations/20260929120000_chief_foundation/`)
- Ported modules in this repository (Phase 2 — model layer):
  - `server/chief/models/types.js` ← `src/openjarvis/core/types.py` (ModelSpec,
    Quantization, RoutingContext)
  - `server/chief/models/complexity.js` ← `src/openjarvis/learning/routing/complexity.py`
  - `server/chief/models/classify.js` ← `src/openjarvis/learning/routing/_utils.py`
  - `server/chief/models/router.js` ← `src/openjarvis/learning/routing/router.py`,
    `src/openjarvis/learning/routing/heuristic_policy.py`,
    `src/openjarvis/learning/_stubs.py` (RouterPolicy, QueryAnalyzer)
  - `server/chief/models/catalog.js` ← `src/openjarvis/intelligence/model_catalog.py`
    (register/merge semantics and the Anthropic catalog rows; xAI rows are new data)
  - `server/chief/models/config.js` ← `src/openjarvis/core/config.py` (IntelligenceConfig,
    RoutingLearningConfig defaults)
  - `server/chief/models/engine.js` ← `src/openjarvis/engine/_stubs.py` (InferenceEngine
    surface), `src/openjarvis/cli/ask.py` (router integration order),
    `src/openjarvis/agents/_stubs.py` (INFERENCE_START/END payloads). The engine zoo itself
    is not ported — the Vercel AI SDK is used directly (audit §2.3).
- Adapted modules in this repository (Phase 5 — scheduler tick):
  - `server/chief/scheduler/schedule.js` ← `src/openjarvis/scheduler/scheduler.py`
    (`_compute_next_run`, `_compute_next_cron` semantics; cron parsing is `cron-parser`)
  - `server/chief/scheduler/operative.js` ← `src/openjarvis/agents/operative.py`
    (`operator:{id}:state` key, "## Previous State" recall, 1000-character auto-persist;
    the OperativeAgent loop is not ported)
- Obligations: retain attribution and license notice for derivative material; the full
  upstream license text is included verbatim at
  `licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt` (including its copyright line,
  "Copyright 2025 The OpenJarvis Authors").
- Optionally, an OpenJarvis server container may be deployed as an external sidecar
  service. In that configuration it is used unmodified over its HTTP API and its own
  license file ships with its own container image; no additional obligation attaches to
  this repository.

## möbius (citizenhicks/mobius)

- Repository: https://github.com/citizenhicks/mobius
- Commit audited: `3e1aaf5039f5069c3142861cb145fc0fb5521284`
- License: Apache License 2.0, with an upstream NOTICE file
- Use in this repository: **ported implementation semantics** for CHIEF (Module 03) —
  the durable turn phase machine with pending-approval suspension, checkpoint schema with
  atomic save and fork, approval policy/decision semantics (including sticky session
  approvals and deny/abort behavior), the frontend-neutral operation/event protocol
  taxonomy, a reduced middleware hook set, and the subagent coordination model. Each ported
  module carries a provenance header naming the upstream source file and commit.
- Ported modules in this repository (Phase 1):
  - `server/chief/runtime/approvals.js` ← `src/backend/sandbox/approval.rs`
  - `server/chief/protocol/index.js` ← `src/protocol/mod.rs`, `src/protocol/events.rs`
  - `chief_session`, `chief_transcript_delta`, `chief_execution_journal`,
    `chief_event_journal`, `chief_middleware_state`, `chief_approval` Prisma models ←
    möbius checkpoint/approval schemas
    (`prisma/migrations/20260929120000_chief_foundation/`)
- Ported modules in this repository (Phase 3):
  - `server/chief/runtime/turn.js` ← `src/agent/turn.rs`, `src/agent/turn/model.rs`,
    `src/agent/mod.rs`
  - `server/chief/runtime/checkpoint.js` ← `src/backend/checkpoint/sqlite.rs`
  - `server/chief/runtime/approvals.js` `restore` / `exportKeys` persist the Phase 1
    sticky-key set on the checkpoint
- `server/chief/models/budget.js` is not a port. The cap idea is reference-only (see
  jarvis-architecture below). The check is CHIEF's own and lives in the model layer
  (ADR-0003).
- Ported modules in this repository (Phase 4), from commit `5e5f5ef`:
  - `server/chief/tools/spec.js` ← `src/openjarvis/tools/_stubs.py` (`ToolSpec`, `BaseTool`)
  - `server/chief/tools/executor.js` ← `src/openjarvis/tools/_stubs.py` (`ToolExecutor.execute`)
  - `server/chief/security/taint.js` ← `src/openjarvis/security/taint.py`
  - `server/chief/security/rate-limit.js` ← `src/openjarvis/security/rate_limiter.py`
    (`TokenBucket.consume`) and `rust/crates/openjarvis-security/src/rate_limiter.rs` (`check`)
  - `server/chief/security/injection.js` ← `src/openjarvis/security/injection_scanner.py`
    (`_INJECTION_PATTERNS`, `_scan_python`)
  - `server/chief/security/boundary.js` ← `src/openjarvis/security/boundary.py`
    (`check_outbound` shape only; scanners are not ported, so block mode refuses non-local
    tools instead of running an empty scanner)
- The Rust tool executor is not ported. OpenJarvis `DEFAULT_TOOL_CAPABILITIES` is not copied.
  `ApprovalStore` is not a second approval path. Read-versus-mutation uses möbius
  `ApprovalRequirement` (`requires_approval` / `requiresConfirmation`) at commit `3e1aaf5`.
  `@modelcontextprotocol/sdk` is not installed: MCP invoke is a remote tool that block mode
  refuses before any network call.
- Adapted modules in this repository (Phase 5):
  - `server/chief/scheduler/store.js` ← `src/backend/bots.rs` (claim under a lock with the
    schedule advanced in the same write; Running/Succeeded/Failed/Skipped run states;
    interrupted runs failed on the next pass). The lock is a row compare-and-swap.
  - `server/chief/scheduler/schedule.js` ← `src/backend/bots.rs` (`advance_interval`
    missed-slot skipping)
  - `server/chief/scheduler/tick.js` ← `src/backend/bots.rs` (`run_routine_with_state`:
    one fresh session per run)
- Obligations: Apache-2.0 attribution — the full upstream license text is included
  verbatim at `licenses/MOBIUS-LICENSE-APACHE-2.0.txt` — **plus propagation of the
  upstream NOTICE** for derivative material, reproduced in full at
  `licenses/MOBIUS-NOTICE.txt` and here in relevant part:

  > möbius
  >
  > This product includes software derived from OpenAI Codex:
  >
  > OpenAI Codex — Copyright 2025 OpenAI
  >
  > OpenAI Codex includes code derived from Ratatui
  > (https://github.com/ratatui/ratatui), licensed under the MIT License.
  > Copyright (c) 2016-2022 Florian Dehau
  > Copyright (c) 2023-2025 The Ratatui Developers

  (The remainder of the upstream NOTICE covers möbius's terminal/Apple client assets —
  Nord palettes, HugeIcons, HighlightSwift, highlight.js, thinking-orbs — which CHIEF does
  not port; the complete NOTICE is nevertheless reproduced verbatim at
  `licenses/MOBIUS-NOTICE.txt`.)

## Hermes Agent (NousResearch/hermes-agent)

- Repository: https://github.com/NousResearch/hermes-agent
- Commit audited: `8c30ef318d1ed6c88597239081f5749268efdca8`
- License: MIT ("Copyright (c) 2025 Nous Research")
- Use in this repository: **adapted semantics only** (Phase 5). No Hermes code, runtime,
  agent loop, or approval behavior is included.
  - `server/chief/scheduler/retry.js` ← `cron/unreachable_retry.py` (retry only a
    transient network failure with zero model calls; 300/900/1800-second ladder; give up
    when the natural next occurrence comes first; recurring tasks only) and
    `cron/scheduler_preflight.py` (cause-chain walk for transient errors)
- Obligations: retain the copyright and permission notice; the full license text is at
  `licenses/HERMES-AGENT-LICENSE-MIT.txt`.

## cortex-map (StovBuilds/cortex-map)

- Repository: https://github.com/StovBuilds/cortex-map
- Commit audited (to be vendored in Phase 7): `68db7b119258c29d434711676838d5a8bbd66ae1`
- License: MIT
- Use in this repository: **vendored source, unmodified** — the 3D memory/knowledge-graph
  renderer for the CHIEF Command Center, to be vendored under `src/third_party/cortex-map/`
  with its upstream `LICENSE` file intact and a `VENDORED.md` recording provenance. Not
  published to npm (verified); vendoring is the reuse mechanism.
- License text (reproduced verbatim from the upstream `LICENSE`):

  > MIT License
  >
  > Copyright (c) 2026 Jack Stovell (NoctemJack)
  >
  > Permission is hereby granted, free of charge, to any person obtaining a copy
  > of this software and associated documentation files (the "Software"), to deal
  > in the Software without restriction, including without limitation the rights
  > to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  > copies of the Software, and to permit persons to whom the Software is
  > furnished to do so, subject to the following conditions:
  >
  > The above copyright notice and this permission notice shall be included in all
  > copies or substantial portions of the Software.
  >
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  > IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  > FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  > LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  > OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  > SOFTWARE.

## StovBuilds/jarvis-architecture

- Repository: https://github.com/StovBuilds/jarvis-architecture
- Commit audited: `51735c8199816062b3f36437bf07c36c9da44c1f`
- License: **none** (no license file, no license grant)
- Use in this repository: **REFERENCE ONLY — nothing is copied.** No code, prose, diagrams,
  or schemas from this repository are reproduced in Freedom OS. Only uncopyrightable
  concepts (e.g. the shape of a knowledge-graph consolidation pipeline, cost-cap
  philosophy, human-in-the-loop reversibility rules) inform CHIEF's design, as recorded in
  the audit.

## npm dependencies used by CHIEF

Installed through npm with licenses shipped in `node_modules`; listed here so the reuse
plan is explicit:

| Package                                                 | License    | Status / use                                                                        |
| ------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `@ai-sdk/xai` (`^5.0.12`)                               | Apache-2.0 | **Installed (Phase 2)** — xAI Grok transport, `server/chief/models/providers.js`    |
| `ai`, `@ai-sdk/anthropic` (pre-existing platform deps)  | Apache-2.0 | **Used (Phase 2–3)** — provider registry, generateText, streamText; Anthropic transport (opt-in) |
| `@ai-sdk/openai-compatible` or `@ai-sdk/openai`         | Apache-2.0 | Planned — OpenAI-compatible socket for the optional OpenJarvis sidecar (Phase 6)    |
| `@modelcontextprotocol/sdk`                             | MIT        | Planned — MCP tool client (Phase 4)                                                 |
| `cron-parser` (`^5.10.1`, depends on `luxon`, MIT)      | MIT        | **Installed (Phase 5)** — cron evaluation, `server/chief/scheduler/schedule.js`     |
| `three`, `react-force-graph-3d`, `react-force-graph-2d` | MIT        | Planned — cortex-map runtime dependencies (Phase 7)                                 |

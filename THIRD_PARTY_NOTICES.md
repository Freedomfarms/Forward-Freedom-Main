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
  shapes. Ported modules land in later phases; each will carry a provenance header.
- Obligations: retain attribution and license notice for derivative material; the full
  Apache-2.0 text is added under `licenses/APACHE-2.0.txt` with the first ported module.
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
  taxonomy, a reduced middleware hook set, and the subagent coordination model. Ported
  modules land in later phases; each will carry a provenance header.
- Obligations: Apache-2.0 attribution as above, **plus propagation of the upstream NOTICE**
  for derivative material, reproduced here in relevant part:

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
  not port; if any such material is ever carried over, the corresponding NOTICE entries
  must be reproduced here as well.)

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

## npm dependencies planned for later CHIEF phases

Installed through npm with licenses shipped in `node_modules`; listed here so the reuse
plan is explicit:

| Package                                                                | License    | Planned use (phase)                       |
| ---------------------------------------------------------------------- | ---------- | ----------------------------------------- |
| `@ai-sdk/xai`, `@ai-sdk/openai` (+ existing `ai`, `@ai-sdk/anthropic`) | Apache-2.0 | Model provider transports (Phase 2)       |
| `@modelcontextprotocol/sdk`                                            | MIT        | MCP tool client (Phase 4)                 |
| `cron-parser`                                                          | MIT        | Schedule parsing (Phase 5)                |
| `three`, `react-force-graph-3d`, `react-force-graph-2d`                | MIT        | cortex-map runtime dependencies (Phase 7) |

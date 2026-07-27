# Phase 2B — CEO Plan Store (architecture proposal)

> **Status: implemented (Phase 2B) on PR #187.**
> Continues PR #187 (Phase 2A already landed on this branch).
>
> Binding implementation constraints: Plan is memory not workflow; Plan ≠
> execution proof; structured ops only; one ACTIVE per user/missionScope;
> anti-thrash (reason + meaningful changes); dual-read migration; meta-only logs.
>
> Binding principle: **CODE OWNS TRUTH · DATABASE OWNS STATE · TOOLS OWN CAPABILITIES · CEO OWNS JUDGMENT**
>
> Aligns with `docs/FREEDOM_BRAIN_V2.md` §0.3 / §3 / §9.1, with CEO-specific
> refinements so Plans replace temporary mission inference.

---

## 1. Problem

After Phase 2A:

| Layer | Owner | Authority |
| --- | --- | --- |
| APPLICATION STATE / world model | code + DB | authoritative |
| PLATFORM CAPABILITIES / control plane | code | allow/deny safety |
| CEO reply | LLM judgment | executive |
| ACTIVE MISSION | `sketchMissionFromConversation` | **inferred, transitional** |

The remaining weakness is **temporary mission inference**. Each turn re-derives
“what the user is trying to do” from recent chat text. That is not durable
executive state. It also keeps `ceoReasoning.js` on the hot path.

Phase 2B introduces a **durable Plan layer** so continuity lives in Postgres,
not in a sketcher.

### Non-goals (explicit)

- Do **not** recreate the old mission sketcher (no `missionKind`, question
  ranking, gap checklists, or forced interview scripts).
- Do **not** add workflow state machines for conversations.
- Do **not** add question trees.
- Do **not** become a project-management app (no milestones, dependency
  graphs, risk registers, progress %, task hierarchies) — same binding as
  Brain v2 §0.3.

---

## 2. Role in the control plane

```
Context → CEO reasoning → Safety → Execution
              ↑
         Plan Store
    (durable executive intent)
```

- **Context** loads the active Plan(s) into the Situation Brief.
- **CEO reasoning** (LLM) proposes Plan updates as tool calls / structured ops.
- **Safety** (control plane) still gates mutations and “Done” claims.
- **Execution** remains tool/capability owned; Plans never grant new powers.

Plans become the **source of ACTIVE MISSION**. Once wired,
`ceoReasoning.js` is deleted from the hot path (then offline tests).

---

## 3. Schema proposal

### 3.1 Prisma (row metadata — plaintext, listable)

Reuse / extend the Brain v2 `Plan` shape. Status set matches CEO needs:

```prisma
enum PlanStatus {
  ACTIVE
  WAITING
  COMPLETED
  ABANDONED
}

model Plan {
  id                   String     @id @default(cuid())
  userId               String
  title                String     // short plaintext label for lists
  status               PlanStatus @default(ACTIVE)
  contentCiphertext    String     // encrypted structured body (below)
  horizon              String?    // advisory: "weeks" | "months" | "quarters"
  sourceConversationId String?
  lastReviewedAt       DateTime?
  createdAt            DateTime   @default(now())
  updatedAt            DateTime   @updatedAt
  user                 User       @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, status, updatedAt])
}
```

Notes vs Brain v2 §9.1:

- `WAITING` replaces `PAUSED` for CEO semantics (“blocked on user/input/external
  dependency”) without inventing a conversation workflow.
- One **primary active plan** per user is the default product rule for CEO
  Mission rendering; multiple ACTIVE rows may exist later, but the assembler
  injects at most one primary + optional related titles until Relevance Engine
  lands.

Forced RLS migration required (same house pattern as `AgentChatMessage` /
`UserMemory`).

### 3.2 Encrypted body (canonical Plan content)

Decrypt only inside server Brain/Plan modules. Shape is JSON, versioned:

```ts
type PlanBodyV1 = {
  v: 1;

  // 1. Objective
  objective: {
    text: string;                 // what the user is trying to accomplish
    confidence: "low" | "medium" | "high";
    createdAt: string;            // ISO
    updatedAt?: string;
  };

  // 2. Situation
  situation: {
    known: string[];              // confirmed / observed facts (short)
    assumptions: string[];        // explicit guesses the CEO is using
    constraints: string[];        // hard limits (budget, time, permissions)
    relevantContext: string[];    // pointers, not dumps (e.g. "Plaid linked")
  };

  // 3. Decisions
  decisions: Array<{
    id: string;
    text: string;
    by: "user" | "ceo";
    rationale: string;
    at: string;                   // ISO
  }>;

  // 4. Open items
  openItems: Array<{
    id: string;
    kind: "question" | "blocker" | "dependency";
    text: string;
    createdAt: string;
  }>;

  // 5. Actions
  actions: Array<{
    id: string;
    text: string;
    owner: "user" | "ceo" | "agent";
    status: "planned" | "completed" | "failed";
    createdAt: string;
    completedAt?: string;
    failureReason?: string;
  }>;

  // Bounded audit (newest-first, hard cap ~50)
  changeLog: Array<{
    at: string;
    op: string;                   // e.g. "set_objective", "add_decision"
    summary: string;
  }>;
};
```

### 3.3 Mapping to ACTIVE MISSION (prompt surface)

Assembler renders **one** section, renamed when Plan exists:

```
ACTIVE MISSION (from Plan)
  plan_id: …
  status: ACTIVE|WAITING|…
  objective: …
  confidence: …
  situation.known: …
  open_items: …
  next_actions: …          // actions where status=planned (top N)
  recent_decisions: …      // last few
```

No sketcher fields: no `missionKind`, `selectedQuestion`, `missing[]`
interview lists, `missionExecutable` booleans derived from heuristics.

### 3.4 Why this is still “simple”

Relative to §0.3’s four buckets:

| §0.3 | Plan body v1 |
| --- | --- |
| mission | `objective` |
| objectives / next actions | `actions` (+ optional split of done/failed) |
| blockers | `openItems` (`blocker` / `dependency` / `question`) |
| changeLog | `changeLog` |

Added only what durable CEO continuity needs: **situation**, **decisions**,
**confidence**, **action outcomes**. Still no PM graph.

Hard caps (server-enforced): e.g. known≤20, assumptions≤12, decisions≤40,
openItems≤20, actions≤40, changeLog≤50, each string ≤500 chars.

---

## 4. Lifecycle

```
                 create (LLM propose → server validate)
                         │
                         ▼
                      ACTIVE ◄──────────────┐
                     /      \               │
                    /        \              │
                   ▼          ▼             │
               WAITING     COMPLETED        │
                   │          (terminal)    │
                   │                        │
                   └──────► ABANDONED ──────┘
                              (terminal)
```

| Transition | Who proposes | Server rules |
| --- | --- | --- |
| → ACTIVE (create) | LLM via `create_plan` / first durable update | Reject empty objective; one primary ACTIVE preferred (demote or refuse second without explicit multi-plan) |
| ACTIVE → WAITING | LLM | Requires at least one open item of kind `blocker`/`dependency`/`question`, or explicit wait rationale in op |
| WAITING → ACTIVE | LLM | Cleared wait reason or resolved open item |
| * → COMPLETED | LLM | Objective text present; optional: no critical open blockers (soft warn, not hard fail) |
| * → ABANDONED | LLM or user-explicit | Always allowed; append changeLog |
| Terminal → ACTIVE | LLM | Only via **new plan** or explicit `reopen` op (new changeLog entry); prefer new plan id for clarity |

No conversation workflow states. Status lives on the Plan row only.

**When to create:** user expresses durable intent (“I want to buy a lake cabin
in five years”, “build a finance agent that emails me weekly”). Ordinary Q&A
does not create a Plan.

**When to update:** meaningful decision, goal change, action completion/
failure, new constraint, resolved blocker — same spirit as Brain reflection
triggers (v2 §0.4), but applied as Plan ops mid-turn when tools run.

**When not to update:** chit-chat, capability questions, one-off lookups.

---

## 5. Update flow

### 5.1 Contract

1. **LLM proposes** structured ops (never raw ciphertext, never free-form
   overwrite of the whole body by default).
2. **Server validates** ops against schema, caps, status transitions, and
   permission ceiling.
3. **Server applies** ops, encrypts new body, writes row, appends changeLog.
4. **Next turn** assembler loads Plan → ACTIVE MISSION section.

### 5.2 Tools (proposed)

| Tool | Purpose |
| --- | --- |
| `get_plan` | Full decrypted body for deep turns (id or primary active) |
| `create_plan` | Create ACTIVE plan with objective (+ optional situation seed) |
| `update_plan` | Apply a list of validated ops |

Ops are small and declarative, for example:

```ts
type PlanOp =
  | { op: "set_objective"; text: string; confidence?: "low"|"medium"|"high" }
  | { op: "set_status"; status: "ACTIVE"|"WAITING"|"COMPLETED"|"ABANDONED" }
  | { op: "add_known" | "add_assumption" | "add_constraint"; text: string }
  | { op: "remove_situation"; field: "known"|"assumptions"|"constraints"|"relevantContext"; text: string }
  | { op: "add_decision"; text: string; by: "user"|"ceo"; rationale: string }
  | { op: "add_open_item"; kind: "question"|"blocker"|"dependency"; text: string }
  | { op: "resolve_open_item"; id: string }
  | { op: "add_action"; text: string; owner: "user"|"ceo"|"agent" }
  | { op: "complete_action"; id: string }
  | { op: "fail_action"; id: string; reason: string }
  | { op: "note"; summary: string }; // changeLog-only
```

Rejected (fail closed):

- Unknown ops / extra fields
- Over-cap arrays
- Status jumps that skip rules above
- Ops that smuggle sketcher fields (`missionKind`, ranked questions, etc.)
- Whole-body replace except a privileged `replace_body` reserved for migrations/admin

### 5.3 Turn sequencing

```
assemble context (load Plan → ACTIVE MISSION)
        → LLM turn (may call update_plan / create_plan)
        → tool execute (validate + persist)
        → optional follow-up LLM with updated tool result
        → safety / Done validators (unchanged)
        → persist assistant reply
```

Plan updates are **side effects of judgment**, not a pre-turn sketcher pass.

### 5.4 Validation module (new)

`server/brain/plans.js` (name from Brain v2):

- `loadPrimaryPlan(userId)`
- `renderActiveMissionFromPlan(plan)`
- `validatePlanOps(body, ops) → { ok, nextBody, errors }`
- `applyPlanOps(...)` (encrypt + prisma)

No import of `ceoReasoning.js`.

---

## 6. Migration path from current ACTIVE MISSION

Current (Phase 2A):

```
ceoContextAssembler
  → sketchMissionFromConversation(...)
  → renderInferredMission(activeMission)
  → section "ACTIVE MISSION (inferred, not authoritative)"
```

### Step A — dual-read (ship first on this PR after design)

1. Add `Plan` table + encrypt helpers + validate/apply.
2. Assembler: if primary Plan exists → render from Plan (authoritative for
   mission continuity). Else → keep inferred sketcher metadata (unchanged
   Phase 2A labeling).
3. Enable `create_plan` / `update_plan` / `get_plan` on CEO tool belt.
4. Prompt: ACTIVE MISSION from Plan is durable state; inferred path remains
   transitional only when no Plan.

### Step B — seed without sketcher resurrection

Do **not** auto-convert sketcher output into Plans every turn.

Optional one-shot seed (user-visible or CEO-proposed):

- If no Plan and conversation clearly states an objective, LLM may
  `create_plan` with low/medium confidence and sparse situation.
- Server does not invent Plans from regex/heuristics.

### Step C — delete sketcher hot path

1. Remove `sketchMissionFromConversation` call from `ceoContextAssembler.js`.
2. If no Plan: render `(no active plan)` — CEO may create one or proceed
   without.
3. Retarget observability to Plan id/status/objective confidence.
4. Mark `ceoReasoning.js` offline-only; delete when acceptance tests no longer
   need it (or rewrite those tests against Plan ops).

### Step D — retire inferred section copy

Rename prompt section to `ACTIVE MISSION` (from Plan) permanently. Update
`CEO_EXECUTIVE_CONTRACT` / `ceoReasoningDependencies.js` migration status to
Phase 2B complete / deletion done.

### Compatibility map (read-only, not stored)

| Old sketcher field | Plan destination |
| --- | --- |
| `mission` | `objective.text` |
| confidence heuristics | `objective.confidence` (LLM-set, server-clamped) |
| `known` | `situation.known` |
| `decision` | `decisions[]` |
| `missing` / selected question | `openItems[]` (kind=question) — only if CEO chooses |
| `missionKind` / rankings | **dropped** |
| `missionExecutable` | **dropped** (execution truth from capabilities + tools) |

---

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Plan becomes a second sketcher (interview script in openItems) | Prompt + validation: openItems are unresolved facts/blockers, not ranked questionnaires; no `selectedQuestion` concept |
| LLM overwrites Plan every turn (noise / thrash) | Prefer sparse ops; rate-limit or require non-empty meaningful change; changeLog visibility in context so CEO sees churn |
| Stale Plan steers worse than no Plan | `confidence`, `lastReviewedAt`, WAITING status; prompt: validate Plan against APPLICATION STATE; CEO may abandon |
| Multiple ACTIVE plans confuse Mission | Product rule: one primary ACTIVE for CEO Mission; others listed as titles only until Relevance Engine |
| Encrypted body schema drift | `v: 1` discriminator; server migrate-on-read; reject unknown versions |
| Plans used to claim false execution progress | Actions `completed` do not imply agent Done; control plane / capability registry remain authoritative for system truth |
| PM-app creep | Cap fields; forbid milestones/deps/graphs in validate; §0.3 binding |
| Privacy | Same envelope encryption + RLS as chat/memory; title plaintext only |
| Dual-read confusion during migration | Explicit authority labels in prompt until Step C; tests for Plan-present vs Plan-absent |
| Tool failure mid-turn leaves Plan partially applied | Apply ops in a single DB transaction per tool call |

---

## 8. Success criteria (for later implementation gate)

- Multi-turn / multi-conversation continuity of objective without sketcher.
- `ceoReasoning.js` absent from Brain hot path.
- ACTIVE MISSION text sourced from Plan when present.
- No workflow states, no question trees, no missionKind classification.
- Lint/build/tests green; Plan op unit tests cover validate/apply/reject paths.

---

## 9. Implementation status

Shipped on PR #187:

1. Prisma `Plan` + RLS migration (`20260727200000_ceo_plan_store`)
2. `server/brain/plans.js` (validate, apply, create/update/get, render)
3. Tools on CEO belt + assembler dual-read
4. Prompt / executive contract updated
5. Tests: `test/ceo-plan-store.test.js` (6 required cases + anti-thrash)

Still open (Phase 3 candidates):

6. Remove sketcher hot path entirely once Plans cover continuity in practice
7. Delete or quarantine `ceoReasoning.js` + rewrite offline acceptance tests

---

## 10. Relationship to PR #187

| Phase | Deliverable | On PR 187 |
| --- | --- | --- |
| 2A | Reduce shadow-reasoning authority | Done |
| 2B design | This document | Done |
| 2B code | Plan store + dual-read migration (Steps A–B) | Done |
| 2B cleanup | Delete sketcher hot path (Step C) | Deferred to Phase 3 gate |

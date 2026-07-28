# CEO World-Model Ownership — Design Review

> **Status:** Investigation complete. Implementation deferred until this design
> is accepted.
>
> **Symptom:** After correctly reporting zero agents, the CEO refused to create
> a Federal Reserve agent and instead answered that it had a completed run on
> record. When challenged, it repeated the same answer.
>
> **Class:** Orchestration / architecture — not an LLM reasoning failure.

---

## 0. Verdict

Intent classification worked. The Agent Registry was correct (0 agents). The
incorrect answer was produced by the **Execution Contract rewrite path**, which
treats **historical `AgentRun` rows as reply evidence** even when the user asked
to **create a new agent**.

A completed run is past evidence. It is not agent membership. The current stack
does not enforce that boundary.

---

## 1. Intent Classification

### What happened

| User message | Control-plane `classifyIntent` | Execution-contract `classifyAgentRequest` |
|---|---|---|
| "How many agents work for me?" | `information_request` | `information_request` |
| "I'd like to create a Federal Reserve agent." | **`new_agent_creation`** | **`action_request`** |
| "You just told me there were no agents" | `information_request` | `clarification_needed` |

Verified with the live classifiers in:

- `server/brain/controlPlane.js` → `classifyIntent`
- `server/agents/executionContract.js` → `classifyAgentRequest`

### Conclusion

**Classification did not fail.** The second request was correctly labeled
`new_agent_creation` / `action_request`. The bug is downstream of intent.

---

## 2. Source-of-Truth Resolution (what the CEO consulted)

Turn pipeline (`api/agents/ceo/chat.js` → `server/brain/index.js` → `brainTurn`):

```
assembleCeoContext
  → loadTeamAgents (Agent Registry / AgentConfig)
  → load recent AgentRun rows (Run History)
  → loadPrimaryActivePlan (Plan Store) OR sketchMissionFromConversation
  → buildApplicationWorldModel (finance/workspace)
  → memories from CEO profile
  → digest + conversation transcript
  → controlPlane + executionState
→ LLM tool loop
→ identity guard → capability guard → execution-contract guard
→ persist reply
```

### Per-source audit for this failure class

| Source | Owner file(s) | What it returned in the bug scenario | Weight today | Why it influenced the reply |
|---|---|---|---|---|
| **Agent Registry** (`AgentConfig`) | `teamContext.js` → `loadTeamAgents` / `renderTeamRoster` | Empty roster: `(no sub-agents yet…)` | Prompt section `YOUR CAPABILITIES` — **should be sole membership authority** | Correctly said 0 agents on turn 1. **Not re-checked** before the create-turn rewrite. |
| **Run History** (`AgentRun`) | `ceoContextAssembler.js` gather + `renderNamedRunSummaries` | Recent Fed/research run summaries; `agentConfigId` may be `null` after delete (`onDelete: SetNull`) | Prompt section `RECENT RUN SUMMARIES` **and** `buildExecutionEvidence(... recentRuns)` | Topic text (“Federal Reserve…”) sits next to an empty roster. More critically, evidence bag uses latest run to ground rewrites. |
| **Plan Store** | `plans.js` / `ACTIVE MISSION` | Optional durable intent (e.g. “Monitor Federal Reserve…”) | Prompt: durable memory, not execution proof (called out in assembler notes) | Can reinforce “Fed work exists” if a Plan remains after agent delete. Not required for this bug. |
| **Mission Store (inferred)** | `ceoReasoning.js` sketcher | Only when no Plan; matches **live roster names** | Soft inferred metadata | With 0 agents, sketcher does **not** invent a Fed agent from runs. Not the primary culprit. |
| **Memory / profile** | CEO profile + `MEMORY_EXTRACTION` job | Preferences / prior facts | `RELEVANT MEMORIES` | Can mention past Fed work; not authoritative for membership. |
| **Daily Digest** | `digest.js` / cached ciphertext | May summarize prior Fed runs | Prompt section | Residue channel after delete. |
| **Conversation transcript** | chat messages + `announceAgentCreatedToCeoChat` | May contain “Team update: I created …” or prior Fed discussion | Prompt: `CONVERSATION SO FAR` | Residue channel; can bias the model toward “already exists.” |
| **Cached APPLICATION STATE** | `worldModel.js` | Finance/workspace aggregates | Trusted for money/workspace domains | Does **not** own agent membership. |
| **Control plane / EXECUTION STATE** | `controlPlane.js` | For create intent with caps available and no tool create: `object_created: no`, blocker `Agent object not created yet.` | Gates “Done / live” claims | Correctly blocks completion claims; **does not force `create_agent`**. |
| **Execution Contract evidence** | `executionContract.js` | `recentRuns` → `historical.latestRunSummary` | **Hard rewrite authority** after the LLM | **Primary incorrect decision point** (see §3–§4). |

There is **no `list_agents` tool**. Membership is a one-shot prompt snapshot. Mid-turn the model cannot re-query the registry.

---

## 3. Entity Resolution — why a historical run satisfied “agent lookup”

### What should never happen

A completed run must never prove that an active agent exists, and must never
block creating a new one.

### What the code does today

1. **Runs survive agent deletion** (`prisma/schema.prisma` — `AgentRun.agentConfigId` is nullable with `onDelete: SetNull`). Audit retention is intentional; membership semantics were not.
2. **Orphaned runs are labeled only by `agentType`**, not as non-members:

   ```text
   [2026-07-20] (research, run …) FOMC held rates; Fed signaled…
   ```

   (`renderNamedRunSummaries` in `teamContext.js`)

3. **Brain prompt regression** vs legacy chat:
   - Legacy (`server/agents/chat.js`): *“prefer the roster over run summaries for membership.”*
   - Brain (`server/brain/prompts.js`): asks roster-only for “which agents,” but **never says runs/Plan/digest ≠ membership.**

4. **Hard failure (reproduced):** when the model’s draft mentions create/complete outcome language, `guardAgentReply` → `groundedExecutionReply` emits:

   > **“I have a completed run on record.”**

   Exact path in `server/agents/executionContract.js`:

   ```js
   } else if (hist.relatedRunStatus === "SUCCEEDED" || hist.latestRunSummary) {
     bits.push("I have a completed run on record.");
   }
   ```

   Wired from `brainTurn` with:

   ```js
   recentRuns: context.worldModel?.operations?.recentRuns || []
   ```

### Reproduction (same classifiers + guard, empty turnState, one Fed run)

| Draft reply | Outcome claims detected | Final user-visible reply |
|---|---|---|
| “I've created a Federal Reserve agent…” | `created` | **I have a completed run on record. I do not have evidence that a new agent was created in this turn.** |
| “I found a completed Federal Reserve report run…” | `completed` (word “completed”) | **I have a completed run on record.** |
| Challenge: “…but I have a completed Federal Reserve run…” | `completed` | **I have a completed run on record.** |

That matches the reported user-visible text.

So entity resolution failed in two layers:

1. **Soft:** prompt/context mixes roster + unlabeled orphan runs → model may skip `create_agent`.
2. **Hard:** Execution Contract rewrite **promotes Run History into the answer** for create-intent turns.

The second layer alone is sufficient to produce the bug even when the model was trying to talk about creation.

---

## 4. Execution Contract — what it checks (and what it misses)

### Checked today

| Check | Mechanism | Covers this bug? |
|---|---|---|
| Evidence validity for outcome verbs (`created`, `emailed`, `scheduled`, `completed`, …) | `validateExecutionClaims` | Partially — strips false “I created,” but then **rewrites using runs** |
| Capability / Done / live claims | `validateCapabilityConsistency` | Blocks “Done/live” without `objectCreated`; does **not** address existence-from-history |
| Identity swaps | `validateIdentityConsistency` | No |
| create_agent fail-closed on missing platform caps | tool belt / control plane | No |

### Not checked today

| Required consistency | Present? |
|---|---|
| **Evidence validity by entity type** (run ≠ agent) | **No** |
| **Conversation consistency** (just said 0 agents → cannot imply agent exists) | **No** |
| **World-model consistency** (every fact has one owner store) | **No** |
| **Source-of-truth consistency** (agent existence ↔ Agent Registry only) | **No** |
| **Creation intent fulfillment** (`new_agent_creation` + missing roster entity → must call `create_agent` or ask a blocking question, never answer from runs) | **No** |

### Why the contract “allowed” the bad response

It did not “allow” a successful create. It **replaced** an unsupported create/complete claim with a canned historical-run sentence. Relative to a create request, that rewrite is itself an invalid world-model claim: it answers the wrong question using the wrong store.

---

## 5. Root Cause

### Exact execution path

1. Turn 1: “How many agents?” → roster empty → correct “none.”
2. Turn 2: “I'd like to create a Federal Reserve agent.”
3. `classifyIntent` → `new_agent_creation` (correct).
4. Assembler injects empty `YOUR CAPABILITIES` **and** `RECENT RUN SUMMARIES` containing Fed topic text (possibly orphaned).
5. LLM drafts a reply that either claims creation or mentions a “completed” Fed run (often without calling `create_agent`).
6. `guardAgentReply` fails claim validation.
7. `groundedExecutionReply` sees `historical.latestRunSummary` and answers **“I have a completed run on record.”**
8. Turn 3 challenge: any draft that again contains “completed” is rewritten to the **same** sentence → apparent stubbornness.

### Which component made the incorrect decision

| Layer | Role |
|---|---|
| **Primary** | `groundedExecutionReply` / Execution Contract — wrong evidence class for create intent |
| **Secondary** | Context assembly — runs presented without non-membership labeling; Brain prompt lacks roster-over-runs rule |
| **Tertiary** | Missing ownership validator — no registry check for existence / anti-existence claims |
| **Not primary** | Intent classifier, Plan sketcher matching, capability registry inventing agents |

### Bug class

**Architecture + orchestration** (source-of-truth conflation), made user-visible by a **deterministic guard rewrite**. Prompt weakness amplifies model confusion but is not sufficient alone to explain the exact canned sentence.

---

## 6. Same class of bugs elsewhere

Anywhere historical residue can be read as current entity state:

1. **Plan / ACTIVE MISSION** treated as proof a live agent or schedule exists.
2. **Digest** summarizing deleted agents’ runs as if they still work for the user.
3. **“Team update: I created …”** chat announcements surviving after delete.
4. **`relatedRunId` full output** implying an operable agent.
5. **Memory extraction** storing “user has a Federal Reserve agent” from run/announce text.
6. **Status vs action confusion** in `groundedExecutionReply` for any action request when `recentRuns` is non-empty.
7. **False existence claims** (“you already have X”) that use no gated outcome verb — currently **ungated**.

---

## 7. Durable architectural fix (proposed — not implemented)

### 7.1 World-Model Ownership Table (binding)

Every fact type has exactly one authoritative store. Other stores may cite it only as **secondary context**, never as proof.

| Fact | Authority ONLY | May cite as history/context | Must never prove |
|---|---|---|---|
| Agent exists / count / membership | **Agent Registry (`AgentConfig`)** | Runs, Plan, digest, chat, memory | — |
| Plan exists / active mission intent | **Plan Store** | Chat, memory | Agent existence, run success |
| Mission executable / live worker | **Agent Registry + schedules** | Plan objectives | Plan text alone |
| Completed execution / what happened | **Run History (`AgentRun`)** | Digest | Agent membership |
| User preferences / durable beliefs | **Memory / profile** | Chat | Agent/plan/run existence |
| Platform can / cannot | **Capability Registry** | — | Agent membership |
| This-turn mutation outcomes | **Tool results + turnState** | — | Historical runs (for first-person “I just…”) |

**Rule:** No component may infer existence of entity type A from evidence owned by entity type B.

### 7.2 Ownership Resolver (new orchestration seam)

Before prompt assembly and again before final reply persist, resolve a structured `WorldModelFacts` object:

```ts
{
  agents: { count, ids, names },          // Registry only
  plans: { activePlanId, objective },     // Plan Store only
  runs: { recent: [...], orphaned: [...] }, // Run History only; orphan flagged
  memory: [...],
  turn: { agentCreated, runTriggered, ... }
}
```

Prompt sections must be labeled with ownership, e.g.:

- `AGENT REGISTRY (sole source of agent membership)`
- `RUN HISTORY (past executions — not membership; orphaned runs marked)`

### 7.3 Execution Contract changes (targeted)

1. **Evidence scoping by request kind + intent**
   - For `new_agent_creation` / agent-mutation action requests: historical runs **must not** appear in grounded replies as the primary answer.
   - Historical runs remain valid for `status_question` / explicit “what did the last run find?” information requests.

2. **Rewrite policy**
   - On unsupported `created` during create intent with empty/missing registry entity:  
     *“No agent was created this turn. You currently have N agents on the registry. I can create the Federal Reserve agent now — confirm to proceed.”*  
     Never: *“I have a completed run on record.”*

3. **New validators**
   - `validateSourceOfTruthConsistency(reply, worldModelFacts)`
     - Claims of agent existence/name → must match Registry.
     - Claims of “no agents” → Registry count === 0.
     - Claims that a run “is” an agent → fail.
   - Optional conversation consistency: if prior assistant message in-window asserted count=0 and registry still 0, reject existence claims.

4. **Creation fulfillment gate** (orchestration, not prompt-only)
   - If intent is `new_agent_creation`, required caps available, and named/implied agent not on registry, then either:
     - `create_agent` tool result exists this turn, or
     - reply is a blocking clarification, or
     - reply is a planned-agent gap explanation  
     — **not** a run-history status sentence.

### 7.4 Context assembly hygiene

1. Mark orphaned runs (`agentConfigId == null` or id ∉ roster) as `orphaned_run` in `RECENT RUN SUMMARIES`.
2. Restore Brain prompt rule: roster is sole membership authority; runs/Plan/digest never prove an agent exists; after delete, runs may remain as history.
3. Allowed framing for history:  
   *“I found that you previously ran a Federal Reserve report. Would you like me to recreate that agent?”*

### 7.5 What this is not

- Not a one-off Federal Reserve special case.
- Not “make the prompt try harder” as the only fix.
- Not deleting run history (audit stays); **ownership and evidence scoping** change.

---

## 8. Recommended implementation order (after approval)

1. **Ownership table + prompt section labels** (assembler + `BRAIN_SYSTEM_PROMPT`).
2. **Fix `groundedExecutionReply` evidence scoping** (stops the exact canned failure immediately).
3. **`validateSourceOfTruthConsistency`** in `brainTurn` after/before execution guard.
4. **Creation fulfillment gate** for `new_agent_creation`.
5. **Orphan run labeling** + tests for the Fed/create-after-zero-agents scenario and the broader class (Plan residue, digest residue, false “already have”).

Evaluation gate: given registry=0 and a Fed orphan run, create-intent must not yield run-on-record; challenge turn must acknowledge zero agents and offer create.

---

## 9. Decision needed

Approve this ownership model and implementation order before code changes land. The minimal patch that stops the reported sentence is §7.3.2; the durable class fix is §7.1–§7.4 together.

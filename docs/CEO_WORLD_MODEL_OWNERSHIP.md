# CEO World-Model Ownership

> **Status:** Approved and implemented.
>
> Hard invariants for CEO world-model consistency. Prevents Run History (and
> other secondary stores) from being treated as proof of agent membership.

---

## 1. Binding ownership map (hard invariant)

Every fact type has **exactly one** authoritative store. No fallback inference
between entity types.

| Fact | Authority ONLY |
|---|---|
| Agent existence | **Agent Registry** (`AgentConfig`) |
| Agent configuration | **Agent Registry** |
| Plan state | **Plan Store** |
| Mission state | **Mission Store / Plan** |
| Historical execution | **Run History** (`AgentRun`) |
| User preferences | **Memory** |

A Run History record may provide **optional context**, but it **cannot** satisfy:

- “Do I have this agent?”
- “Modify this agent”
- “This agent already exists”

Allowed history framing:

> “I don't currently have a Federal Reserve agent. I found that you previously
> ran a similar report. Would you like me to create a new recurring agent based
> on that?”

Forbidden:

> “I have a completed run on record.” *(as the answer to a create/existence ask)*

---

## 2. Root cause (investigation summary)

Intent classification correctly returned `new_agent_creation`. The Agent
Registry correctly returned 0 agents. The user-visible sentence *“I have a
completed run on record.”* was produced by `groundedExecutionReply` in the
Execution Contract, which used historical `AgentRun` rows as rewrite evidence
on create-intent turns.

Full path analysis lives in git history for this document’s first revision;
implementation below encodes the durable fix.

---

## 3. Implementation

| Piece | Location |
|---|---|
| Ownership map + validators | `server/brain/worldModelOwnership.js` |
| Execution-contract scoping | `server/agents/executionContract.js` (`groundedExecutionReply` / `guardAgentReply`) |
| Assembler labels + facts | `server/brain/ceoContextAssembler.js` |
| Orphan run labeling | `server/agents/teamContext.js` |
| Prompt constitution | `server/brain/prompts.js` |
| Turn wiring | `server/brain/index.js` (`enforceWorldModelOwnership` after execution guard) |
| Regression tests | `test/ceo-world-model-ownership.test.js` |

### Validators (before final persist)

1. **Source-of-truth** — block run→agent, plan→execution, memory→capability cross claims.
2. **Conversation consistency** — prior “no agents” + current run-as-agent framing requires clarification.
3. **Creation fulfillment** — create-agent turns may only end as:
   - **A)** Agent created + Registry/turn evidence
   - **B)** Missing information / confirm-to-create
   - **C)** Creation blocked with reason  
   Never a historical-run-only summary.

### Execution Contract

- `new_agent_creation` / modification intents **never** rewrite via generic `recentRuns`.
- Status questions may still cite Run History.
- Create/update claims require Registry / this-turn tool evidence.

---

## 4. Evaluation gate

Given registry = 0 and an orphan Fed run:

1. Create-intent must not yield “completed run on record.”
2. Reply must state no Federal Reserve agent on the registry and may offer recreate from history.
3. Challenge turn must acknowledge the mismatch and explain historical run ≠ active agent.

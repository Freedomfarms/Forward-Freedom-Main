# CEO World-Model Ownership

> **Status:** Approved and implemented. Core CEO invariant.
>
> **Principle:** Context can enrich a decision. Context cannot redefine reality.

Harry must always distinguish:

- **“I did this before”** → Run History (historical context only)
- **“I currently have this operating for you”** → Agent Registry (verified current state)

---

## 1. Binding ownership map (hard invariant)

Every fact type has **exactly one** authoritative store. No cross-entity inference.

| Fact | Authority ONLY |
|---|---|
| Agent existence | **Agent Registry** (`AgentConfig`) |
| Agent status / configuration | **Agent Registry** |
| Plan state | **Plan Store** |
| Mission state | **Mission Store / Plan** |
| Execution history | **Run History** (`AgentRun`) |
| User preferences | **Memory** |

Run History may **enrich** a proposal. It must **never** satisfy:

- “Do I have this agent?”
- “Modify this agent”
- “This agent already exists”
- A `new_agent_creation` request

### Allowed

> Your Agent Registry has no Federal Reserve Monitor. I found a previous Federal
> Reserve report in Run History. Would you like me to create a new agent?

### Not allowed

> You have a Federal Reserve agent because a previous run exists.

### Entity resurrection (deleted agent)

Lifecycle: create → run → delete → Run History remains → user asks about agent.

Expected:

> No active agent exists. I found historical runs from that agent.

Never:

> The agent exists because historical runs exist.

---

## 2. Creation fulfillment

For `new_agent_creation`, the CEO may only complete via:

| Path | Meaning |
|---|---|
| **A** | Agent Registry confirms creation (this-turn `create_agent`) |
| **B** | Missing information / confirm-to-create is requested |
| **C** | Creation blocked with a reason (capabilities, etc.) |

Run History may improve the proposal. It must never satisfy the creation request.

---

## 3. Claim provenance (debug)

For development/debugging, every ownership-grounded reply emits structured claims:

```
Claim:
"I don't have a Federal Reserve agent."

Source:
Agent Registry

Confidence:
Verified current state

---

Claim:
"You previously ran a Federal Reserve report."

Source:
Run History

Confidence:
Historical context only
```

Implementation:

- `buildResponseClaims` / `formatClaimProvenance` / `logClaimProvenance` in
  `server/brain/worldModelOwnership.js`
- Logged when `FREEDOM_OS_DEBUG_CEO` observability is on (`[ceo-observability]`
  phase `claim_provenance`)

---

## 4. Implementation map

| Piece | Location |
|---|---|
| Ownership map + validators + claims | `server/brain/worldModelOwnership.js` |
| Execution-contract scoping | `server/agents/executionContract.js` |
| Assembler labels + facts | `server/brain/ceoContextAssembler.js` |
| Orphan run labeling | `server/agents/teamContext.js` |
| Prompt constitution | `server/brain/prompts.js` |
| Turn wiring + claim logs | `server/brain/index.js` |
| Lifecycle / resurrection tests | `test/ceo-world-model-ownership.test.js` |

### Validators (before final persist)

1. **Source-of-truth** — block run→agent, plan→execution, memory→capability
2. **Conversation consistency** — prior “no agents” vs run-as-agent framing
3. **Creation fulfillment** — A / B / C only
4. **Modification against Registry** — cannot modify a non-existent agent from runs
5. **Entity resurrection** — deleted agents are not revived from Run History

---

## 5. Evaluation gate

1. 0 agents + historical Fed run + create request → Registry-negative + history as context + offer create
2. Deleted agent + orphan runs + “how’s my Fed agent?” → no active agent + historical runs noted
3. Challenge contradiction → explain historical run ≠ active agent
4. Claim provenance logs Registry vs Run History with correct confidence

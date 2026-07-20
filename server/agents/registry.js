import { AgentError } from "./errors.js";
import { runFinanceAgent } from "./types/finance.js";
import { runResearchAgent } from "./types/research.js";
import { runRemindersAgent } from "./types/reminders.js";

// ─────────────────────────────────────────────────────────────────────────────
// agentType → handler registry. This is the single source of truth for which
// agent types can execute. Fail-closed by design:
//   • built types (finance, research, reminders) map to real handlers;
//   • "email" is registered (the schema knows it) but its handler throws a
//     typed "not yet available" error — deliberately unbuilt;
//   • anything else raises UNKNOWN_AGENT_TYPE.
// ─────────────────────────────────────────────────────────────────────────────

function emailAgentNotAvailable() {
  throw new AgentError(
    'The "email" agent type is not yet available. It is schema-ready but its runtime has not been built.',
    "AGENT_TYPE_NOT_AVAILABLE",
    501
  );
}

const AGENT_HANDLERS = Object.freeze({
  finance: runFinanceAgent,
  research: runResearchAgent,
  reminders: runRemindersAgent,
  email: emailAgentNotAvailable,
});

export const BUILT_AGENT_TYPES = Object.freeze(["finance", "research", "reminders"]);

export function isBuiltAgentType(agentType) {
  return BUILT_AGENT_TYPES.includes(agentType);
}

export function getAgentHandler(agentType) {
  if (typeof agentType !== "string" || !agentType.trim()) {
    throw new AgentError("Agent type is missing.", "UNKNOWN_AGENT_TYPE", 400);
  }
  if (!Object.prototype.hasOwnProperty.call(AGENT_HANDLERS, agentType)) {
    throw new AgentError(`Unknown agent type "${agentType}".`, "UNKNOWN_AGENT_TYPE", 400);
  }
  return AGENT_HANDLERS[agentType];
}

// The runner's dispatch gate: resolves the handler AND rejects registered but
// unbuilt types up-front, so the "not yet available" case is recorded as a
// skipped run instead of ever starting one.
export function getRunnableAgentHandler(agentType) {
  const handler = getAgentHandler(agentType);
  if (!isBuiltAgentType(agentType)) {
    // Registered but unbuilt (currently: email). Invoke the stub so the typed
    // error it throws is the single definition of that failure.
    handler();
  }
  return handler;
}

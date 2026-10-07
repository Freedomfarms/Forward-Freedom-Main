// Wires the ported context pieces into a TurnMachine. Chat, approvals, and
// the scheduler tick share this so a scheduled turn and a user turn recall
// the same facts. No second runtime.

import { agentContextReader } from "../agents/context.js";
import { Capability } from "../core/capabilities.js";
import { applyMemoryCommands } from "../memory/commands.js";
import { rememberExchange } from "../memory/extract.js";
import { createMemoryAccess } from "../memory/provider.js";
import { CHIEF_COMPACTION_TOKENS, CHIEF_KEEP_RECENT_TOKENS } from "../runtime/compaction.js";
import { createContextAssembler, lastTurnUserText } from "./assemble.js";
import { renderConversationMove, settleReply } from "./behavior.js";
import { orchestrateContext, renderContextPackage } from "./orchestrate.js";

function workforceReadGranted(policy) {
  return Boolean(
    policy &&
    typeof policy.check === "function" &&
    policy.check("_default", Capability.WORKFORCE_READ) === true
  );
}

function readersWithWorkforce(contextReaders, capabilityPolicy, agentRuntime) {
  const readers = { ...(contextReaders ?? {}) };
  if (readers.agents || !workforceReadGranted(capabilityPolicy)) return readers;
  if (agentRuntime) {
    readers.agents = agentContextReader(agentRuntime);
    return readers;
  }
  readers.agents = async (ctx) => {
    const { createAgentRuntime } = await import("../agents/index.js");
    return agentContextReader(createAgentRuntime())(ctx);
  };
  return readers;
}

export function createChiefTurnServices({
  facts,
  engine,
  checkpointStore = null,
  capabilityPolicy = null,
  eventBus = null,
  moduleAccess = null,
  contextReaders = {},
  agentRuntime = null,
  now = null,
  atTokens = CHIEF_COMPACTION_TOKENS,
  keepRecentTokens = CHIEF_KEEP_RECENT_TOKENS,
} = {}) {
  if (!facts || !engine) {
    throw new TypeError("createChiefTurnServices requires facts and engine");
  }
  const memory = createMemoryAccess({ facts, checkpointStore });
  const readers = readersWithWorkforce(contextReaders, capabilityPolicy, agentRuntime);
  let prepared = null;
  const assemble = createContextAssembler({
    facts,
    checkpointStore,
    capabilityPolicy,
    bus: eventBus,
    moduleAccess,
  });
  return {
    contextAssembler: async (turn) => {
      const prompt = await assemble(turn);
      const query = lastTurnUserText(turn?.transcript);
      let pack;
      try {
        pack = await orchestrateContext({
          query,
          userId: turn?.userId,
          sessionId: turn?.sessionId ?? null,
          transcript: turn?.transcript ?? null,
          memory,
          readers,
          availableTools: turn?.availableTools ?? null,
          now: typeof now === "function" ? now() : now instanceof Date ? now : new Date(),
        });
        prepared = pack;
      } catch {
        pack = null;
        prepared = null;
      }
      const section = renderContextPackage(pack);
      const move = renderConversationMove(turn?.transcript, query);
      return [prompt, section, move].filter(Boolean).join("\n\n");
    },
    compaction: { atTokens, keepRecentTokens },
    memory,
    settleModelStep: ({ transcript, text, toolCalls }) =>
      settleReply({ transcript, text, toolCalls, pack: prepared }),
    onTurnComplete: async (exchange) => {
      await applyMemoryCommands({ facts, ...exchange, provider: memory.provider });
      return rememberExchange({ facts, engine, ...exchange });
    },
  };
}

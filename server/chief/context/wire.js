// Wires the ported context pieces into a TurnMachine. Chat, approvals, and
// the scheduler tick share this so a scheduled turn and a user turn recall
// the same facts. No second runtime.

import { applyMemoryCommands } from "../memory/commands.js";
import { rememberExchange } from "../memory/extract.js";
import { createMemoryAccess } from "../memory/provider.js";
import { CHIEF_COMPACTION_TOKENS, CHIEF_KEEP_RECENT_TOKENS } from "../runtime/compaction.js";
import { createContextAssembler, lastTurnUserText } from "./assemble.js";
import { renderConversationMove } from "./behavior.js";
import { orchestrateContext, renderContextPackage } from "./orchestrate.js";

export function createChiefTurnServices({
  facts,
  engine,
  checkpointStore = null,
  capabilityPolicy = null,
  eventBus = null,
  moduleAccess = null,
  contextReaders = {},
  atTokens = CHIEF_COMPACTION_TOKENS,
  keepRecentTokens = CHIEF_KEEP_RECENT_TOKENS,
} = {}) {
  if (!facts || !engine) {
    throw new TypeError("createChiefTurnServices requires facts and engine");
  }
  const memory = createMemoryAccess({ facts, checkpointStore });
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
          readers: contextReaders,
          availableTools: turn?.availableTools ?? null,
        });
      } catch {
        pack = null;
      }
      const section = renderContextPackage(pack);
      const move = renderConversationMove(turn?.transcript, query);
      return [prompt, section, move].filter(Boolean).join("\n\n");
    },
    compaction: { atTokens, keepRecentTokens },
    memory,
    onTurnComplete: async (exchange) => {
      await applyMemoryCommands({ facts, ...exchange, provider: memory.provider });
      return rememberExchange({ facts, engine, ...exchange });
    },
  };
}

// Wires the ported context pieces into a TurnMachine. Chat, approvals, and
// the scheduler tick share this so a scheduled turn and a user turn recall
// the same facts. No second runtime.

import { rememberExchange } from "../memory/extract.js";
import { CHIEF_COMPACTION_TOKENS, CHIEF_KEEP_RECENT_TOKENS } from "../runtime/compaction.js";
import { createContextAssembler } from "./assemble.js";

export function createChiefTurnServices({
  facts,
  engine,
  checkpointStore = null,
  capabilityPolicy = null,
  atTokens = CHIEF_COMPACTION_TOKENS,
  keepRecentTokens = CHIEF_KEEP_RECENT_TOKENS,
} = {}) {
  if (!facts || !engine) {
    throw new TypeError("createChiefTurnServices requires facts and engine");
  }
  return {
    contextAssembler: createContextAssembler({ facts, checkpointStore, capabilityPolicy }),
    compaction: { atTokens, keepRecentTokens },
    onTurnComplete: (exchange) => rememberExchange({ facts, engine, ...exchange }),
  };
}

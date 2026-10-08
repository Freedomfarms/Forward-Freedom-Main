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
import {
  isDelegationConversationReply,
  isDelegationFollowUp,
  peekDelegation,
  shouldLoadWorkforcePicture,
} from "./delegation.js";
import { orchestrateContext, renderContextPackage } from "./orchestrate.js";

function workforceReadGranted(policy) {
  return Boolean(
    policy &&
    typeof policy.check === "function" &&
    policy.check("_default", Capability.WORKFORCE_READ) === true
  );
}

async function readWorkforcePicture(agentRuntime, userId, now) {
  if (typeof userId !== "string" || userId.trim() === "") return null;
  const clock = typeof now === "function" ? now : () => (now instanceof Date ? now : new Date());
  try {
    const runtime =
      agentRuntime ?? (await import("../agents/index.js")).createAgentRuntime({ now: clock });
    if (typeof runtime?.picture !== "function") return null;
    return await runtime.picture(userId, { now: clock() });
  } catch {
    return null;
  }
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
  let preparedUserId = null;
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
      preparedUserId = turn?.userId ?? null;
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
    settleModelStep: async ({ transcript, text, toolCalls, delegationIntent = null }) => {
      const peeked = peekDelegation(text, toolCalls);
      const packHasAgents = (prepared?.items ?? []).some(
        (item) => item?.sourceType === "live_agent_state" && item.sourceId !== "workforce-coverage"
      );
      let workforcePicture = null;
      const latest = lastTurnUserText(transcript);
      if (
        !isDelegationFollowUp(transcript, latest, delegationIntent) &&
        shouldLoadWorkforcePicture(peeked, delegationIntent, latest) &&
        !packHasAgents &&
        workforceReadGranted(capabilityPolicy)
      ) {
        workforcePicture = await readWorkforcePicture(agentRuntime, preparedUserId, now);
      }
      return settleReply({
        transcript,
        text,
        toolCalls,
        pack: prepared,
        workforcePicture,
        delegationIntent,
      });
    },
    onTurnComplete: async (exchange) => {
      await applyMemoryCommands({ facts, ...exchange, provider: memory.provider });
      if (isDelegationConversationReply(exchange.assistantText)) {
        return { stored: 0, skipped: "delegation" };
      }
      return rememberExchange({ facts, engine, ...exchange });
    },
  };
}

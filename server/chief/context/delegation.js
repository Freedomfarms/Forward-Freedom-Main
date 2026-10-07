// Phase 1 delegation is a statement of intent.
// It does not submit work, open an approval, or call a workforce command.

import { messageText } from "../runtime/compaction.js";
import { isForbiddenControlTool } from "../control/plane.js";
import { parseWorkforceFact } from "./workforceAnswer.js";

const EFFECTS = new Set(["read", "change", "deploy", "external"]);
const RECORD = /DELEGATION\s+(\{[\s\S]*?\})/i;
const PROPOSAL = /I'd delegate:|I would delegate to the technical workforce/i;

const STANDING_CONSTRAINT = "Do not change Freedom Financial or XRP";
const OUTCOME = Object.freeze({
  change: "Working change with tests passing",
  deploy: "A deployment only once it is actually reported",
});

const ACCEPT_TEXT =
  "Understood. The delegation is approved in principle, but this phase does not submit work to the workforce yet.";
const DECLINE_TEXT = "Understood. I will not delegate that. Nothing was submitted.";

function spoken(text) {
  return String(text ?? "")
    .trim()
    .replace(/[!?.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRecord(text) {
  const match = String(text ?? "").match(RECORD);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    if (!value || typeof value !== "object") return null;
    const effect = EFFECTS.has(value.effect) ? value.effect : null;
    if (!effect) return null;
    return {
      effect,
      objective: typeof value.objective === "string" ? value.objective.trim() : "",
      outcome: typeof value.outcome === "string" ? value.outcome.trim() : "",
    };
  } catch {
    return null;
  }
}

function effectFromTools(toolCalls) {
  const forbidden = (toolCalls ?? []).filter((call) => isForbiddenControlTool(call?.name));
  if (forbidden.length === 0) return null;
  if (forbidden.some((call) => call.name === "deploy")) return "deploy";
  return "change";
}

export function peekDelegation(text, toolCalls = []) {
  const record = parseRecord(text);
  const fromTools = effectFromTools(toolCalls);
  const effect = fromTools ?? record?.effect ?? null;
  const delegate = effect === "change" || effect === "deploy";
  return {
    delegate,
    effect,
    objective: record?.objective ?? "",
    outcome: record?.outcome ?? "",
    text: String(text ?? "")
      .replace(RECORD, "")
      .trim(),
    needsPicture: delegate,
  };
}

function workforceItems(pack) {
  return (pack?.items ?? []).filter(
    (item) =>
      item?.origin === "live" &&
      item.available !== false &&
      item.sourceType === "live_agent_state" &&
      item.sourceId &&
      item.sourceId !== "workforce-coverage"
  );
}

function fromPack(pack) {
  const items = workforceItems(pack);
  if (items.length === 0) {
    const coverage = (pack?.items ?? []).find((item) => item?.sourceId === "workforce-coverage");
    if (!coverage?.source) return null;
    return { provider: coverage.source, agents: [] };
  }
  return {
    provider: items[0].source ?? "",
    agents: items
      .map((item) => {
        const fact = parseWorkforceFact(item);
        if (!fact || !item.sourceId) return null;
        return {
          id: String(item.sourceId),
          name: fact.name,
          liveness: fact.liveness ?? "",
          revoked: fact.revoked === true,
        };
      })
      .filter(Boolean),
  };
}

function fromPicture(picture) {
  if (!picture || typeof picture !== "object") return null;
  const provider = typeof picture.provider === "string" ? picture.provider : "";
  const agents = (picture.agents ?? [])
    .map((agent) => {
      const id = typeof agent?.id === "string" ? agent.id.trim() : "";
      if (!id) return null;
      return {
        id,
        name: agent.displayName || id,
        liveness: typeof agent.liveness === "string" ? agent.liveness.toLowerCase() : "",
        revoked: picture.revoked === true,
      };
    })
    .filter(Boolean);
  return { provider, agents };
}

function observed(pack, workforcePicture) {
  return fromPicture(workforcePicture) ?? fromPack(pack) ?? { provider: "", agents: [] };
}

function eligible(agent) {
  return agent.revoked !== true && agent.liveness !== "stale";
}

function mentions(text, agent) {
  const source = String(text ?? "");
  const name = agent.name
    ? new RegExp(`\\b${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
    : null;
  const id = new RegExp(`\\b${agent.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return (name ? name.test(source) : false) || id.test(source);
}

function preferenceItems(pack) {
  return (pack?.items ?? []).filter(
    (item) =>
      item?.origin === "memory" && (item.scope === "preference" || item.sourceType === "preference")
  );
}

function chooseAgent(agents, pack) {
  const open = agents.filter(eligible);
  if (open.length === 1) return open[0];
  if (open.length === 0) return null;
  const prefs = preferenceItems(pack);
  const named = open.filter((agent) => prefs.some((item) => mentions(item.text, agent)));
  if (named.length === 1) return named[0];
  return null;
}

function safeOutcome(effect, proposed) {
  const fallback = OUTCOME[effect];
  if (!proposed) return fallback;
  if (/\b(already|submitted|started|completed|deployed|passed)\b/i.test(proposed)) return fallback;
  return proposed;
}

function constraintsFrom(pack) {
  const extra = preferenceItems(pack)
    .map((item) => String(item.text ?? "").trim())
    .filter((text) => text && text.length <= 160 && !/should handle/i.test(text))
    .slice(0, 2);
  return [STANDING_CONSTRAINT, ...extra];
}

export function buildDelegationDecision({ proposal, userText, pack, workforcePicture }) {
  const seen = observed(pack, workforcePicture);
  const agent = chooseAgent(seen.agents, pack);
  const objective =
    proposal.objective || String(userText ?? "").trim() || "The requested technical work";
  return {
    disposition: "delegate",
    objective,
    constraints: constraintsFrom(pack),
    outcome: safeOutcome(proposal.effect, proposal.outcome),
    provider: seen.provider,
    agentId: agent?.id ?? "",
    effect: proposal.effect,
    confirm: true,
    agentName: agent?.name ?? "",
  };
}

export function delegationSpeech(decision) {
  const approval = "This would require your approval before execution.";
  if (!decision.agentId) {
    return `This is work I would delegate to the technical workforce: ${decision.objective}. I don't have a single suitable observed agent to name yet. ${approval} Nothing has been submitted.`;
  }
  return [
    "That should be handled by the technical workforce rather than me.",
    `I'd delegate: ${decision.objective}, with ${decision.outcome}, while leaving Freedom Financial and XRP untouched.`,
    `The current observed agent is ${decision.agentName}.`,
    approval,
    "Nothing has been submitted.",
  ].join(" ");
}

function previousAssistant(transcript) {
  const messages = Array.isArray(transcript) ? transcript : [];
  let seenUser = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      if (seenUser) continue;
      seenUser = true;
      continue;
    }
    if (seenUser && messages[index]?.role === "assistant")
      return messageText(messages[index]).trim();
  }
  return "";
}

export function isDelegationFollowUp(transcript, userText) {
  return followUp(userText, transcript) != null;
}

function followUp(userText, transcript) {
  const prior = previousAssistant(transcript);
  if (!PROPOSAL.test(prior) || /does not submit work/i.test(prior)) return null;
  const compact = spoken(userText);
  if (/^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please|please do)$/i.test(compact)) {
    return "accept";
  }
  if (
    /^(?:no|nope|nah|don't|dont|do not|stop|never mind|nevermind|nvm|forget it)$/i.test(compact)
  ) {
    return "decline";
  }
  return null;
}

export function settleDelegation({
  transcript = [],
  text = "",
  toolCalls = [],
  pack = null,
  workforcePicture = null,
  userText = "",
} = {}) {
  const follow = followUp(userText, transcript);
  if (follow === "accept") {
    return {
      handled: true,
      text: ACCEPT_TEXT,
      toolCalls: [],
      delegation: null,
      clearDelegation: false,
    };
  }
  if (follow === "decline") {
    return {
      handled: true,
      text: DECLINE_TEXT,
      toolCalls: [],
      delegation: null,
      clearDelegation: true,
    };
  }
  const peeked = peekDelegation(text, toolCalls);
  if (peeked.delegate) {
    const decision = buildDelegationDecision({
      proposal: peeked,
      userText,
      pack,
      workforcePicture,
    });
    const { agentName, ...stored } = decision;
    return {
      handled: true,
      text: delegationSpeech(decision),
      toolCalls: [],
      delegation: stored,
      clearDelegation: false,
      agentName,
    };
  }
  return {
    handled: false,
    effect: peeked.effect,
    text: peeked.text,
    toolCalls: (toolCalls ?? []).filter((call) => !isForbiddenControlTool(call?.name)),
    delegation: null,
    clearDelegation: false,
  };
}

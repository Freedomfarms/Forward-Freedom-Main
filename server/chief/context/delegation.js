// Delegation is a statement of intent carried on the turn checkpoint.
// Accepting, revising, or clearing it does not submit work, open an approval,
// or call a workforce command.

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
  "Understood. The delegation is accepted in principle. Execution isn't connected yet, so nothing has been submitted.";
const DECLINE_TEXT = "Understood. I will not delegate that. Nothing was submitted.";
const ACCEPT_UTTERANCE =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please|please do|proceed|that(?:'s| is) fine|have the agent do it|send it|ok(?:ay)?, do that)$/i;
const DECLINE_UTTERANCE =
  /^(?:no|nope|nah|don't|dont|do not|stop|never mind|nevermind|nvm|forget it|don't do it|dont do it|do not do it|cancel that|i changed my mind)$/i;

function spoken(text) {
  return String(text ?? "")
    .trim()
    .replace(/[’‘]/g, "'")
    .replace(/[!?.,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeObjective(value) {
  return spoken(value).toLowerCase();
}

function parseRecord(text) {
  const match = String(text ?? "").match(RECORD);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    if (!value || typeof value !== "object") return null;
    const effect = EFFECTS.has(value.effect) ? value.effect : null;
    if (!effect) return null;
    const constraints = Array.isArray(value.constraints)
      ? value.constraints
          .filter((item) => typeof item === "string" && item.trim())
          .map((item) => item.trim())
          .slice(0, 4)
      : [];
    return {
      effect,
      objective: typeof value.objective === "string" ? value.objective.trim() : "",
      outcome: typeof value.outcome === "string" ? value.outcome.trim() : "",
      constraints,
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
    constraints: record?.constraints ?? [],
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
    constraints: mergeConstraints(constraintsFrom(pack), proposal.constraints),
    outcome: safeOutcome(proposal.effect, proposal.outcome),
    provider: seen.provider,
    agentId: agent?.id ?? "",
    effect: proposal.effect,
    confirm: true,
    status: "pending",
    agentName: agent?.name ?? "",
  };
}

function mergeConstraints(existing, extra) {
  const next = Array.isArray(existing) ? [...existing] : [];
  for (const item of extra ?? []) {
    const text = String(item ?? "").trim();
    if (!text) continue;
    if (next.some((current) => current.toLowerCase() === text.toLowerCase())) continue;
    next.push(text);
  }
  return next;
}

function isDelegationIntent(intent) {
  return (
    intent?.disposition === "delegate" && (intent.effect === "change" || intent.effect === "deploy")
  );
}

function isPending(intent) {
  return isDelegationIntent(intent) && intent.status !== "accepted";
}

function copyIntent(pending, status) {
  return {
    disposition: "delegate",
    objective: pending.objective,
    constraints: Array.isArray(pending.constraints) ? [...pending.constraints] : [],
    outcome: pending.outcome,
    provider: typeof pending.provider === "string" ? pending.provider : "",
    agentId: typeof pending.agentId === "string" ? pending.agentId : "",
    effect: pending.effect,
    confirm: pending.confirm === true,
    status,
  };
}

function sameWork(pending, peeked) {
  if (!isDelegationIntent(pending) || !peeked?.delegate) return false;
  if (peeked.effect !== pending.effect) return false;
  if (!peeked.objective) return true;
  return normalizeObjective(peeked.objective) === normalizeObjective(pending.objective);
}

export function shouldLoadWorkforcePicture(peeked, pending, userText = "") {
  if (!peeked?.needsPicture) return false;
  if (utteranceKind(userText)) return false;
  return !sameWork(pending, peeked);
}

function addedConstraints(pending, peeked) {
  const current = new Set((pending.constraints ?? []).map((item) => item.toLowerCase()));
  return (peeked.constraints ?? []).filter((item) => !current.has(item.toLowerCase()));
}

function constraintSpeech(decision, added) {
  return `Updated. I'd still delegate: ${decision.objective}. Added limit: ${added.join("; ")}. Nothing has been submitted.`;
}

function observedNow(pack, workforcePicture) {
  if (workforcePicture && typeof workforcePicture === "object")
    return fromPicture(workforcePicture);
  if (workforceItems(pack).length > 0) return fromPack(pack);
  return null;
}

function refreshCandidate(intent, pack, workforcePicture) {
  if (!isDelegationIntent(intent) || !intent.agentId) return null;
  const seen = observedNow(pack, workforcePicture);
  if (!seen) return null;
  const match = seen.agents.find((agent) => agent.id === intent.agentId);
  if (match && eligible(match)) return null;
  return copyIntent(
    { ...intent, agentId: "" },
    intent.status === "accepted" ? "accepted" : "pending"
  );
}

export function isDelegationConversationReply(text) {
  return /I'd delegate:|I'd still delegate:|I would delegate to the technical workforce|accepted in principle|I will not delegate that|Added limit:/i.test(
    String(text ?? "")
  );
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

function utteranceKind(userText) {
  const compact = spoken(userText);
  if (ACCEPT_UTTERANCE.test(compact)) return "accept";
  if (DECLINE_UTTERANCE.test(compact)) return "decline";
  return null;
}

function proposalOpen(transcript) {
  const prior = previousAssistant(transcript);
  if (!PROPOSAL.test(prior)) return false;
  if (/does not submit work|isn't connected yet|accepted in principle/i.test(prior)) return false;
  return true;
}

export function isDelegationFollowUp(transcript, userText, pending = null) {
  return followUp(userText, transcript, pending) != null;
}

function followUp(userText, transcript, pending = null) {
  const kind = utteranceKind(userText);
  if (!kind) return null;
  const open = isPending(pending) || pending?.status === "accepted" || proposalOpen(transcript);
  if (!open) return null;
  if (kind === "accept" && !isPending(pending)) return null;
  return kind;
}

function keptToolCalls(toolCalls) {
  return (toolCalls ?? []).filter((call) => !isForbiddenControlTool(call?.name));
}

export function settleDelegation({
  transcript = [],
  text = "",
  toolCalls = [],
  pack = null,
  workforcePicture = null,
  userText = "",
  pending = null,
} = {}) {
  const peeked = peekDelegation(text, toolCalls);
  const follow = followUp(userText, transcript, pending);
  if (follow === "accept" && isPending(pending)) {
    return {
      handled: true,
      text: ACCEPT_TEXT,
      toolCalls: [],
      delegation: copyIntent(pending, "accepted"),
      clearDelegation: false,
    };
  }
  if (follow === "decline" && (isDelegationIntent(pending) || proposalOpen(transcript))) {
    return {
      handled: true,
      text: DECLINE_TEXT,
      toolCalls: [],
      delegation: null,
      clearDelegation: true,
    };
  }
  if (utteranceKind(userText) === "accept" || utteranceKind(userText) === "decline") {
    return {
      handled: false,
      effect: peeked.effect === "change" || peeked.effect === "deploy" ? null : peeked.effect,
      text: peeked.text,
      toolCalls: keptToolCalls(toolCalls),
      delegation: null,
      clearDelegation: false,
    };
  }
  if (sameWork(pending, peeked)) {
    const added = addedConstraints(pending, peeked);
    if (added.length > 0) {
      const next = copyIntent(pending, "pending");
      next.constraints = mergeConstraints(pending.constraints, added);
      return {
        handled: true,
        text: constraintSpeech(next, added),
        toolCalls: [],
        delegation: next,
        clearDelegation: false,
      };
    }
    return {
      handled: false,
      effect: null,
      text: peeked.text,
      toolCalls: [],
      delegation: refreshCandidate(pending, pack, workforcePicture),
      clearDelegation: false,
    };
  }
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
    toolCalls: keptToolCalls(toolCalls),
    delegation: refreshCandidate(pending, pack, workforcePicture),
    clearDelegation: false,
  };
}

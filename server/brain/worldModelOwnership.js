import { CEO_INTENTS, looksLikeAgentCreationRequest } from "./controlPlane.js";

// ─────────────────────────────────────────────────────────────────────────────
// World-model ownership — hard invariants.
//
// Every fact type has exactly one authoritative store. Other stores may provide
// optional context but must never satisfy cross-entity proofs.
// ─────────────────────────────────────────────────────────────────────────────

/** Binding ownership map. No fallback inference between entity types. */
export const WORLD_MODEL_OWNERS = Object.freeze({
  AGENT_EXISTENCE: "agent_registry",
  AGENT_CONFIGURATION: "agent_registry",
  PLAN_STATE: "plan_store",
  MISSION_STATE: "mission_store",
  HISTORICAL_EXECUTION: "run_history",
  USER_PREFERENCES: "memory",
});

export const OWNERSHIP_FAILURES = Object.freeze({
  RUN_EVIDENCE_FOR_AGENT_CLAIM: "run_evidence_used_for_agent_claim",
  AGENT_EXISTENCE_WITHOUT_REGISTRY: "agent_existence_without_registry",
  PLAN_USED_FOR_EXECUTION_CLAIM: "plan_used_for_execution_claim",
  MEMORY_USED_FOR_CAPABILITY_CLAIM: "memory_used_for_capability_claim",
  HISTORICAL_USED_FOR_CURRENT_STATE: "historical_used_for_current_state",
  CONVERSATION_RUN_VS_REGISTRY: "conversation_consistency_run_vs_registry",
  CREATION_ANSWERED_WITH_RUN_HISTORY: "creation_answered_with_run_history",
  CREATION_UNFULFILLED: "creation_unfulfilled",
});

/**
 * Build structured facts with explicit owners. Agent membership is Registry-only.
 */
export function buildWorldModelFacts({
  teamAgents = [],
  runs = [],
  activeMission = null,
  turnState = null,
  priorAssistantReplies = [],
} = {}) {
  const agents = Array.isArray(teamAgents) ? teamAgents : [];
  const rosterIds = new Set(agents.map((agent) => agent?.id).filter(Boolean));
  const recent = Array.isArray(runs) ? runs : [];
  const orphaned = recent.filter(
    (run) => !run?.agentConfigId || !rosterIds.has(run.agentConfigId)
  );

  return {
    owners: WORLD_MODEL_OWNERS,
    agents: {
      owner: WORLD_MODEL_OWNERS.AGENT_EXISTENCE,
      count: agents.length,
      ids: agents.map((agent) => agent.id).filter(Boolean),
      names: agents.map((agent) => String(agent.name || "").trim()).filter(Boolean),
      byId: Object.fromEntries(
        agents.filter((agent) => agent?.id).map((agent) => [agent.id, agent])
      ),
    },
    plans: {
      owner: WORLD_MODEL_OWNERS.PLAN_STATE,
      activePlanId: activeMission?.authority === "plan" ? activeMission.planId || null : null,
      objective:
        activeMission?.authority === "plan"
          ? activeMission.mission || activeMission.objective || null
          : null,
    },
    mission: {
      owner: WORLD_MODEL_OWNERS.MISSION_STATE,
      authority: activeMission?.authority || null,
      mission: activeMission?.mission || null,
      missionKind: activeMission?.missionKind || null,
    },
    runs: {
      owner: WORLD_MODEL_OWNERS.HISTORICAL_EXECUTION,
      recent,
      orphaned,
      latestSummary: recent[0]?.summary || null,
    },
    memory: {
      owner: WORLD_MODEL_OWNERS.USER_PREFERENCES,
    },
    turn: {
      agentCreated: Boolean(turnState?.agent?.id),
      agentId: turnState?.agent?.id || null,
      agentName: turnState?.agent?.name || null,
      runTriggered: Boolean(turnState?.run?.id),
    },
    conversation: {
      priorAssistantReplies: Array.isArray(priorAssistantReplies)
        ? priorAssistantReplies.map(String)
        : [],
      priorAssertedNoAgents: priorAssistantReplies.some(assertsNoAgents),
    },
  };
}

export function isCreationLikeIntent(intent, userMessage = "") {
  return (
    intent === CEO_INTENTS.NEW_AGENT_CREATION ||
    intent === CEO_INTENTS.RECURRING_MISSION ||
    looksLikeAgentCreationRequest(userMessage)
  );
}

export function isModificationIntent(intent) {
  return intent === CEO_INTENTS.AGENT_MODIFICATION;
}

/** Topic phrase from "create a Federal Reserve agent" → "Federal Reserve". */
export function extractRequestedAgentTopic(message) {
  const text = String(message || "").trim();
  if (!text) return null;
  const patterns = [
    /\b(?:create|build|set up|stand up)\b(?:\s+(?:me\s+)?(?:an?|the))?\s+(.+?)\s+agents?\b/i,
    /\b(?:i(?:'d| would) like to create)\b(?:\s+(?:an?|the))?\s+(.+?)\s+agents?\b/i,
    /\b(?:new|recurring)\s+(.+?)\s+agents?\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const topic = cleanTopic(match[1]);
      if (topic) return topic;
    }
  }
  if (/\bfederal\s+reserve\b/i.test(text)) return "Federal Reserve";
  return null;
}

function cleanTopic(raw) {
  return String(raw || "")
    .replace(/^(?:an?|the|my|our)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!,;:]+$/g, "");
}

export function findSimilarHistoricalRun(runs = [], topic = null) {
  const list = Array.isArray(runs) ? runs : [];
  if (!list.length) return null;
  const topicTokens = tokenize(topic);
  if (!topicTokens.length) {
    const first = list[0];
    return first
      ? {
          summary: first.summary || null,
          orphaned: !first.agentConfigId,
          hint: first.summary ? `: ${truncate(first.summary, 80)}` : "",
        }
      : null;
  }
  for (const run of list) {
    const hay = `${run.summary || ""} ${run.agentType || ""}`.toLowerCase();
    if (topicTokens.every((token) => hay.includes(token)) || topicTokens.some((token) => hay.includes(token) && token.length > 4)) {
      return {
        summary: run.summary || null,
        orphaned: !run.agentConfigId,
        hint: run.summary ? `: ${truncate(run.summary, 80)}` : "",
      };
    }
  }
  return null;
}

function tokenize(topic) {
  return String(topic || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 2 && !["the", "and", "for", "agent", "report"].includes(part));
}

function truncate(text, max) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function assertsNoAgents(text) {
  return /\b(don'?t have any agents|do not have any agents|you have no agents|no (?:sub-)?agents(?: yet)?|zero agents|haven'?t created any(?: agents)?|not created any(?: agents)?)\b/i.test(
    String(text || "")
  );
}

export function claimsAgentAlreadyExists(reply) {
  const text = String(reply || "");
  return (
    /\b(already have|you already have|you have an? existing|existing agent|agent already exists|already set up|already on (?:your )?roster|already on (?:the )?registry)\b/i.test(
      text
    ) ||
    /\byour\b.{0,40}\b(agent|monitor|watcher)\b.{0,40}\b(is ready|is active|is live|is set up|already)\b/i.test(
      text
    )
  );
}

export function claimsAgentMembershipFromRunHistory(reply) {
  const text = String(reply || "");
  if (/\bcompleted run on record\b/i.test(text)) return true;
  if (
    /\b(completed|prior|previous|historical)\b.{0,60}\b(run|report)\b/i.test(text) &&
    /\b(agent|monitor|watcher)\b/i.test(text) &&
    /\b(have|has|exists?|existing|already|on record)\b/i.test(text)
  ) {
    return true;
  }
  if (
    /\b(found|have)\b.{0,40}\b(completed|prior|previous)\b.{0,40}\b(federal reserve|fed)\b.{0,40}\b(run|report|agent)\b/i.test(
      text
    ) &&
    !/\b(would you like me to create|create a new|recreate)\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

export function isHistoricalRunPrimaryReply(reply) {
  const text = String(reply || "").trim();
  if (!text) return false;
  if (/^i have a completed run on record\.?$/i.test(text)) return true;
  if (
    /\bcompleted run on record\b/i.test(text) &&
    !/\b(don'?t currently have|do not currently have|not on (?:your )?registry|would you like me to create)\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (
    claimsAgentMembershipFromRunHistory(text) &&
    !offersToCreateAgent(text) &&
    !isClarificationReply(text) &&
    !isCreationBlockedReply(text)
  ) {
    return true;
  }
  return false;
}

export function offersToCreateAgent(reply) {
  return /\b(would you like me to create|want me to create|i can create|shall i create|create a new|recreate that agent|create one now)\b/i.test(
    String(reply || "")
  );
}

export function isClarificationReply(reply) {
  const text = String(reply || "");
  if (offersToCreateAgent(text)) return true;
  if (/\?\s*$/.test(text.trim()) && /\b(which|what|when|how often|should i|do you want|would you like)\b/i.test(text)) {
    return true;
  }
  if (/\b(need|missing|before i (?:can )?create|tell me|confirm)\b/i.test(text) && /\?/i.test(text)) {
    return true;
  }
  return false;
}

export function isCreationBlockedReply(reply, capabilityAssessment = null) {
  const text = String(reply || "");
  if (
    /\b(not (?:currently )?connected|capabilities? (?:are )?not|cannot create|can't create|blocked|unavailable)\b/i.test(
      text
    )
  ) {
    return true;
  }
  if (capabilityAssessment && capabilityAssessment.allAvailable === false) {
    return /\b(design|planned|gap|connect)\b/i.test(text);
  }
  return false;
}

function registryHasTopic(facts, topic) {
  if (!topic) return false;
  const needle = String(topic).toLowerCase();
  return (facts?.agents?.names || []).some((name) => {
    const value = String(name).toLowerCase();
    return value.includes(needle) || needle.includes(value);
  });
}

/**
 * Validate that claims use the correct owner store / entity type.
 */
export function validateSourceOfTruthConsistency(
  reply,
  facts,
  { intent = null, userMessage = "" } = {}
) {
  const failures = [];
  const text = String(reply || "");
  if (!text) return { ok: true, failures };

  const creationLike = isCreationLikeIntent(intent, userMessage);
  const modificationLike = isModificationIntent(intent);
  const agentCreatedThisTurn = Boolean(facts?.turn?.agentCreated);

  if (claimsAgentAlreadyExists(text) && !agentCreatedThisTurn) {
    const topic = extractRequestedAgentTopic(userMessage);
    if ((facts?.agents?.count || 0) === 0 || (topic && !registryHasTopic(facts, topic))) {
      failures.push(OWNERSHIP_FAILURES.AGENT_EXISTENCE_WITHOUT_REGISTRY);
    }
  }

  if (claimsAgentMembershipFromRunHistory(text) && !agentCreatedThisTurn) {
    const topic = extractRequestedAgentTopic(userMessage);
    if ((facts?.agents?.count || 0) === 0 || (topic && !registryHasTopic(facts, topic))) {
      failures.push(OWNERSHIP_FAILURES.RUN_EVIDENCE_FOR_AGENT_CLAIM);
      failures.push(OWNERSHIP_FAILURES.HISTORICAL_USED_FOR_CURRENT_STATE);
    }
  }

  if (
    (creationLike || modificationLike) &&
    isHistoricalRunPrimaryReply(text) &&
    !agentCreatedThisTurn
  ) {
    failures.push(OWNERSHIP_FAILURES.RUN_EVIDENCE_FOR_AGENT_CLAIM);
  }

  // Plan intent must not be treated as proof of completed execution.
  if (
    /\b(plan|mission)\b/i.test(text) &&
    /\b(already (?:ran|completed|executed)|execution (?:is )?complete|successfully executed)\b/i.test(
      text
    ) &&
    !facts?.turn?.runTriggered
  ) {
    failures.push(OWNERSHIP_FAILURES.PLAN_USED_FOR_EXECUTION_CLAIM);
  }

  // Memory / preference language must not invent platform capabilities.
  if (
    /\b(from memory|i remember|you prefer)\b/i.test(text) &&
    /\b(connected|capability|capabilities|can trade|trading is (?:live|enabled))\b/i.test(text)
  ) {
    failures.push(OWNERSHIP_FAILURES.MEMORY_USED_FOR_CAPABILITY_CLAIM);
  }

  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

/**
 * Prior "no agents" + current run-as-agent framing needs clarification.
 */
export function validateConversationConsistency(reply, facts) {
  const failures = [];
  const text = String(reply || "");
  if (!text) return { ok: true, failures };

  const priorNoAgents = Boolean(facts?.conversation?.priorAssertedNoAgents);
  const registryEmpty = (facts?.agents?.count || 0) === 0;
  if (!priorNoAgents || !registryEmpty) return { ok: true, failures };

  if (
    claimsAgentAlreadyExists(text) ||
    claimsAgentMembershipFromRunHistory(text) ||
    isHistoricalRunPrimaryReply(text)
  ) {
    failures.push(OWNERSHIP_FAILURES.CONVERSATION_RUN_VS_REGISTRY);
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Create-agent turns may only end as: created, missing info, or blocked.
 */
export function validateCreationFulfillment(
  reply,
  {
    intent = null,
    userMessage = "",
    facts = null,
    turnState = null,
    capabilityAssessment = null,
  } = {}
) {
  const failures = [];
  if (!isCreationLikeIntent(intent, userMessage)) {
    return { ok: true, failures, path: null };
  }

  if (turnState?.agent?.id || facts?.turn?.agentCreated) {
    return { ok: true, failures, path: "created" };
  }

  const text = String(reply || "");
  if (isClarificationReply(text)) {
    return { ok: true, failures, path: "missing_info" };
  }
  if (isCreationBlockedReply(text, capabilityAssessment)) {
    return { ok: true, failures, path: "blocked" };
  }
  if (isHistoricalRunPrimaryReply(text) || claimsAgentMembershipFromRunHistory(text)) {
    failures.push(OWNERSHIP_FAILURES.CREATION_ANSWERED_WITH_RUN_HISTORY);
    return { ok: false, failures, path: "run_history" };
  }
  if (claimsAgentAlreadyExists(text)) {
    const topic = extractRequestedAgentTopic(userMessage);
    if ((facts?.agents?.count || 0) === 0 || (topic && !registryHasTopic(facts, topic))) {
      failures.push(OWNERSHIP_FAILURES.CREATION_UNFULFILLED);
      return { ok: false, failures, path: "false_existence" };
    }
  }

  // Soft offer / acknowledgement without create still needs an explicit create path.
  if (offersToCreateAgent(text)) {
    return { ok: true, failures, path: "missing_info" };
  }

  failures.push(OWNERSHIP_FAILURES.CREATION_UNFULFILLED);
  return { ok: false, failures, path: "unfulfilled" };
}

/** Best-effort topic from the user message, run history, or prior replies. */
export function resolveAgentTopic(userMessage = "", facts = null, draftReply = "") {
  const fromMessage = extractRequestedAgentTopic(userMessage);
  if (fromMessage) return fromMessage;
  const fromDraft = extractRequestedAgentTopic(draftReply) || extractTopicFromText(draftReply);
  if (fromDraft) return fromDraft;
  const fromRuns = extractTopicFromRuns(facts?.runs?.recent || []);
  if (fromRuns) return fromRuns;
  for (const prior of facts?.conversation?.priorAssistantReplies || []) {
    const fromPrior = extractTopicFromText(prior);
    if (fromPrior) return fromPrior;
  }
  return null;
}

function extractTopicFromText(text) {
  const value = String(text || "");
  if (/\bfederal\s+reserve\b/i.test(value)) return "Federal Reserve";
  const named = value.match(
    /\b([A-Z][A-Za-z0-9&-]*(?:\s+[A-Z][A-Za-z0-9&-]*){0,3})\s+(?:agent|monitor|watcher|report)\b/
  );
  if (named?.[1] && !/^(That|This|Your|The|An|A)$/i.test(named[1])) {
    return cleanTopic(named[1]);
  }
  return null;
}

function extractTopicFromRuns(runs = []) {
  for (const run of runs) {
    const fromSummary = extractTopicFromText(run?.summary || "");
    if (fromSummary) return fromSummary;
    if (/\bfed\b/i.test(run?.summary || "")) return "Federal Reserve";
  }
  return null;
}

/**
 * Grounded reply that respects ownership: Registry for membership, runs as context only.
 */
export function groundedOwnershipReply({
  facts = null,
  userMessage = "",
  failures = [],
  capabilityAssessment = null,
  draftReply = "",
} = {}) {
  const topic = resolveAgentTopic(userMessage, facts, draftReply);
  const count = facts?.agents?.count || 0;
  const similar = findSimilarHistoricalRun(
    facts?.runs?.recent || facts?.runs?.orphaned || [],
    topic
  );
  const capsBlocked = capabilityAssessment && capabilityAssessment.allAvailable === false;
  const topicLabel = topic || "requested";

  if (capsBlocked) {
    return `I can design a ${topicLabel} agent, but required capabilities are not currently connected, so I cannot create it as a live agent yet.`;
  }

  const membership = topic
    ? count === 0
      ? `I don't currently have a ${topic} agent.`
      : `I don't see a ${topic} agent on your registry.`
    : count === 0
      ? "You still have no agents on your registry."
      : "That agent is not on your registry.";

  const needsConversationClarify = failures.includes(
    OWNERSHIP_FAILURES.CONVERSATION_RUN_VS_REGISTRY
  );

  if (similar) {
    const clarify = needsConversationClarify
      ? " That earlier result is historical run evidence, not an active agent on your registry — those are different things."
      : "";
    return `${membership}${clarify} I found that you previously ran a similar report. Would you like me to create a new recurring agent based on that?`;
  }

  if (needsConversationClarify) {
    return `${membership} A past run is history only and does not mean an active agent exists. Would you like me to create a new ${topicLabel} agent now?`;
  }

  return `${membership} Would you like me to create one now?`;
}
/**
 * Enforce ownership + conversation + creation fulfillment. Pure; call before persist.
 */
export function enforceWorldModelOwnership({
  reply,
  facts = null,
  intent = null,
  requestKind = null,
  userMessage = "",
  turnState = null,
  capabilityAssessment = null,
} = {}) {
  const source = validateSourceOfTruthConsistency(reply, facts, { intent, userMessage });
  const conversation = validateConversationConsistency(reply, facts);
  const creation = validateCreationFulfillment(reply, {
    intent,
    userMessage,
    facts,
    turnState,
    capabilityAssessment,
  });

  const failures = [
    ...source.failures,
    ...conversation.failures,
    ...creation.failures,
  ];
  const unique = [...new Set(failures)];

  if (!unique.length) {
    return {
      ok: true,
      rewritten: false,
      reply: String(reply || "").trim(),
      failures: [],
      requestKind: requestKind || null,
      creationPath: creation.path,
    };
  }

  const rewritten = groundedOwnershipReply({
    facts,
    userMessage,
    failures: unique,
    capabilityAssessment,
    draftReply: reply,
  });

  return {
    ok: false,
    rewritten: true,
    reply: rewritten,
    failures: unique,
    requestKind: requestKind || null,
    creationPath: creation.path,
  };
}

/** Prompt-facing ownership constitution (structured, not soft style advice). */
export function renderWorldModelOwnershipSection(facts = null) {
  const count = facts?.agents?.count ?? 0;
  const orphaned = facts?.runs?.orphaned?.length ?? 0;
  return [
    "WORLD MODEL OWNERSHIP (hard invariants — no cross-entity inference):",
    `- agent_existence_owner: ${WORLD_MODEL_OWNERS.AGENT_EXISTENCE}`,
    `- agent_configuration_owner: ${WORLD_MODEL_OWNERS.AGENT_CONFIGURATION}`,
    `- plan_state_owner: ${WORLD_MODEL_OWNERS.PLAN_STATE}`,
    `- mission_state_owner: ${WORLD_MODEL_OWNERS.MISSION_STATE}`,
    `- historical_execution_owner: ${WORLD_MODEL_OWNERS.HISTORICAL_EXECUTION}`,
    `- user_preferences_owner: ${WORLD_MODEL_OWNERS.USER_PREFERENCES}`,
    `- registry_agent_count: ${count}`,
    `- orphaned_runs_in_history: ${orphaned}`,
    "rules:",
    "- Agent existence/membership/configuration: AGENT REGISTRY only.",
    "- Run History is optional context. It never proves an agent exists, is modifiable, or should block creating a new agent.",
    "- Plans/missions are intent memory, not execution proof and not agent membership.",
    "- Memory stores preferences, not capabilities or agent membership.",
    '- Allowed history framing: "I found that you previously ran X. Would you like me to recreate that agent?"',
  ].join("\n");
}

export function extractPriorAssistantReplies(historyRows = [], decryptFn) {
  if (!Array.isArray(historyRows) || typeof decryptFn !== "function") return [];
  const out = [];
  // history is newest-first in assembler gather; walk chronological for priors.
  const chronological = [...historyRows].reverse();
  for (const row of chronological) {
    if (row?.role !== "AGENT" && row?.role !== "agent") continue;
    try {
      const text = decryptFn(row.contentCiphertext);
      if (text && !/^Team update:/i.test(text)) out.push(text);
    } catch {
      // skip undecryptable
    }
  }
  return out.slice(-6);
}

import { dataSection } from "../agents/prompts.js";
import {
  AGENT_DEFINITION_STATUS,
  buildPlannedAgentDefinition,
} from "../agents/agentDefinition.js";
import {
  assessCapabilities,
  detectPlatformNames,
  listCapabilities,
  renderCapabilityRegistry,
  resolveRequiredCapabilities,
} from "../capabilities/registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// CEO control plane — capability truth + execution safety.
//
// Answers: "Is this action allowed?" / "Can we claim Done?"
// Does NOT answer: "What should the CEO think?" / "What question next?"
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Soft labels for safety gates only — not prompt steering. */
export const CEO_INTENTS = Object.freeze({
  INFORMATION_REQUEST: "information_request",
  ONE_TIME_TASK: "one_time_task",
  RECURRING_MISSION: "recurring_mission",
  NEW_AGENT_CREATION: "new_agent_creation",
  AGENT_MODIFICATION: "agent_modification",
});

/**
 * Lightweight request shape for safety gates (creation vs not).
 * Not injected as interview steering — used for Done/live validation only.
 */
export function classifyIntent(message) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();

  if (
    (/\b(make my|change|update|rename|pause|resume|reschedule|tweak|edit)\b/i.test(text) &&
      /\b(agent|report|schedule|digest|reminder|brief)\b/i.test(text))
  ) {
    return CEO_INTENTS.AGENT_MODIFICATION;
  }

  if (
    (/\b(create|build|set up|stand up)\b/i.test(lower) &&
      /\b(agent|bot|monitor|watcher)\b/i.test(lower)) ||
    /\b(i need an? agent|trading agent|monitoring agent)\b/i.test(lower)
  ) {
    if (
      /\b(every|daily|weekly|monday|tuesday|wednesday|thursday|friday|weekday|recurring|schedule)\b/i.test(
        lower
      )
    ) {
      return CEO_INTENTS.RECURRING_MISSION;
    }
    return CEO_INTENTS.NEW_AGENT_CREATION;
  }

  if (
    /\b(every|daily|weekly|monday|friday|schedule|recurring)\b/i.test(lower) &&
    /\b(monitor|track|watch|report|email me|alert)\b/i.test(lower)
  ) {
    return CEO_INTENTS.RECURRING_MISSION;
  }

  if (
    /\b(run|check|look up|research|summarize|remind me)\b/i.test(lower) &&
    !/\b(create|build|set up|agents?)\b/i.test(lower)
  ) {
    return CEO_INTENTS.ONE_TIME_TASK;
  }

  return CEO_INTENTS.INFORMATION_REQUEST;
}

/**
 * Control-plane assessment: required capabilities + allow/deny for mutations.
 * Does not select questions or prescribe mission type to the model.
 */
export function assessControlPlaneRequest({ message = "" } = {}) {
  const text = String(message || "");
  const intent = classifyIntent(text); // safety-gate label only
  const platforms = detectPlatformNames(text);
  const required = resolveRequiredCapabilities({
    message: text,
    platforms,
  });
  const capabilityAssessment = assessCapabilities(required);
  const creationLike =
    intent === CEO_INTENTS.NEW_AGENT_CREATION ||
    intent === CEO_INTENTS.RECURRING_MISSION ||
    looksLikeAgentCreationRequest(text);

  let plannedAgent = null;
  if (creationLike && !capabilityAssessment.allAvailable) {
    plannedAgent = buildPlannedAgentDefinition({
      name: null,
      type: null,
      purpose: text.slice(0, 200) || "Planned agent",
      requiredCapabilities: required,
      schedule: intent === CEO_INTENTS.RECURRING_MISSION ? { requested: true } : null,
    });
  }

  return {
    // Kept for Done validators / execution state — not for interview steering.
    intent,
    requiredCapabilities: required,
    capabilityAssessment,
    plannedAgent,
    platforms,
    systemAction: {
      // Answering / explaining is always allowed.
      possible: true,
      // Mutations that need missing caps are not allowed.
      mutationsAllowed: capabilityAssessment.allAvailable || required.length === 0,
      canClaimComplete: false,
      reason: capabilityAssessment.allAvailable
        ? "Required capabilities available (or none required)."
        : "Required capabilities unavailable — do not claim live completion.",
    },
  };
}

/**
 * Execution state the CEO must satisfy before saying "Done".
 */
export function buildExecutionState({
  intent = null,
  capabilityAssessment = null,
  turnState = null,
  agentDefinition = null,
  userMessage = "",
} = {}) {
  const assessment = capabilityAssessment || assessCapabilities([]);
  const agent = turnState?.agent || null;
  const definition = agentDefinition || null;
  const resolvedIntent = intent || classifyIntent(userMessage);

  const objectCreated = Boolean(agent?.id);
  const agentRegistered = Boolean(agent?.id && agent?.agentType);
  const scheduleCreated = Boolean(
    agent?.schedule?.preset ||
      (definition?.schedule &&
        definition.schedule !== null &&
        definition.status === AGENT_DEFINITION_STATUS.ACTIVE)
  );
  const integrationsConnected = assessment.allAvailable;
  const dataSourceAvailable =
    assessment.allAvailable &&
    assessment.unavailable.length === 0 &&
    (assessment.required.length === 0 || assessment.available.length > 0);

  const creationIntent =
    resolvedIntent === CEO_INTENTS.NEW_AGENT_CREATION ||
    resolvedIntent === CEO_INTENTS.RECURRING_MISSION ||
    looksLikeAgentCreationRequest(userMessage);

  const blockers = [...(assessment.blockers || [])];
  if (creationIntent && !assessment.allAvailable) {
    blockers.push("Required platform capabilities are not connected.");
  }
  if (creationIntent && assessment.allAvailable && !objectCreated) {
    blockers.push("Agent object not created yet.");
  }
  if (
    creationIntent &&
    resolvedIntent === CEO_INTENTS.RECURRING_MISSION &&
    objectCreated &&
    !scheduleCreated
  ) {
    blockers.push("Schedule not created.");
  }

  const canClaimComplete =
    assessment.allAvailable &&
    (!creationIntent || (objectCreated && agentRegistered)) &&
    (resolvedIntent !== CEO_INTENTS.RECURRING_MISSION || scheduleCreated || !creationIntent);

  return {
    objectCreated,
    agentRegistered,
    scheduleCreated,
    integrationsConnected,
    dataSourceAvailable,
    canClaimComplete,
    blockers: uniqueStrings(blockers),
    intent: resolvedIntent,
    agentId: agent?.id || definition?.id || null,
    agentStatus: definition?.status || (agent ? AGENT_DEFINITION_STATUS.ACTIVE : null),
  };
}

/**
 * Deterministic check: reject hallucinated completion claims.
 */
export function validateCapabilityConsistency(
  reply,
  {
    userMessage = "",
    intent = null,
    capabilityAssessment = null,
    executionState = null,
  } = {}
) {
  const failures = [];
  const text = String(reply || "").trim();
  if (!text) return { ok: true, failures };

  const assessment = capabilityAssessment || assessCapabilities([]);
  const resolvedIntent = intent || classifyIntent(userMessage);
  const state =
    executionState ||
    buildExecutionState({
      intent: resolvedIntent,
      capabilityAssessment: assessment,
      userMessage,
    });

  const claimsComplete = claimsMissionComplete(text);
  const claimsLiveAgent = claimsAgentLive(text);
  const acknowledgesGap = acknowledgesCapabilityGap(text);

  if (!assessment.allAvailable && (claimsComplete || claimsLiveAgent) && !acknowledgesGap) {
    failures.push("claimed_complete_without_capabilities");
  }

  if (
    (resolvedIntent === CEO_INTENTS.NEW_AGENT_CREATION ||
      resolvedIntent === CEO_INTENTS.RECURRING_MISSION ||
      looksLikeAgentCreationRequest(userMessage)) &&
    !assessment.allAvailable &&
    claimsLiveAgent &&
    !acknowledgesGap
  ) {
    failures.push("claimed_agent_live_with_unavailable_capabilities");
  }

  if (claimsComplete && !state.canClaimComplete && !acknowledgesGap) {
    failures.push("claimed_done_without_execution_state");
  }

  if (!assessment.allAvailable) {
    for (const cap of assessment.unavailable) {
      if (cap.id === "stock_trading" && claimsTradingLive(text) && !acknowledgesGap) {
        failures.push("claimed_trading_capability");
      }
      if (
        (cap.id === "social_media_monitoring" || cap.id.endsWith("_connector")) &&
        claimsSocialLive(text) &&
        !acknowledgesGap
      ) {
        failures.push("claimed_social_monitoring_live");
      }
    }
  }

  return { ok: failures.length === 0, failures: [...new Set(failures)] };
}

export function renderCapabilitySituationBrief({
  controlPlane = null,
  executionState = null,
  includeRegistry = true,
} = {}) {
  const sections = [];
  if (includeRegistry) {
    sections.push(
      dataSection(
        "PLATFORM CAPABILITIES (authoritative registry)",
        renderCapabilityRegistry(listCapabilities())
      )
    );
  }

  if (controlPlane) {
    const assessment = controlPlane.capabilityAssessment || assessCapabilities([]);
    sections.push(
      dataSection(
        "CONTROL PLANE ASSESSMENT (allow/deny safety — not judgment)",
        [
          `mutations_allowed: ${controlPlane.systemAction?.mutationsAllowed ? "yes" : "no"}`,
          `required_capabilities: ${formatList(controlPlane.requiredCapabilities)}`,
          `unavailable: ${formatList(assessment.unavailable.map((c) => c.id))}`,
          `blockers: ${formatList(assessment.blockers)}`,
          `reason: ${controlPlane.systemAction?.reason || "(none)"}`,
          controlPlane.plannedAgent
            ? [
                "planned_agent_if_blocked:",
                `  status: ${controlPlane.plannedAgent.status}`,
                `  purpose: ${controlPlane.plannedAgent.purpose}`,
                `  capabilities: ${formatList(controlPlane.plannedAgent.capabilities)}`,
                `  blockers: ${formatList(controlPlane.plannedAgent.blockers)}`,
              ].join("\n")
            : "planned_agent_if_blocked: (none)",
        ].join("\n")
      )
    );
  }

  if (executionState) {
    sections.push(
      dataSection(
        "EXECUTION STATE",
        [
          `object_created: ${executionState.objectCreated ? "yes" : "no"}`,
          `agent_registered: ${executionState.agentRegistered ? "yes" : "no"}`,
          `schedule_created: ${executionState.scheduleCreated ? "yes" : "no"}`,
          `integrations_connected: ${executionState.integrationsConnected ? "yes" : "no"}`,
          `data_source_available: ${executionState.dataSourceAvailable ? "yes" : "no"}`,
          `can_claim_complete: ${executionState.canClaimComplete ? "yes" : "no"}`,
          `blockers: ${formatList(executionState.blockers)}`,
        ].join("\n")
      )
    );
  }

  return sections;
}

export function renderCapabilityValidationRetry(controlPlane, failures = [], executionState = null) {
  const assessment = controlPlane?.capabilityAssessment || assessCapabilities([]);
  return dataSection(
    "CAPABILITY CONTROL-PLANE CORRECTION",
    [
      `validation_failed: ${failures.join(", ") || "capability_inconsistency"}`,
      `unavailable_capabilities: ${formatList(assessment.unavailable.map((c) => c.id))}`,
      `blockers: ${formatList(assessment.blockers)}`,
      `execution.can_claim_complete: ${executionState?.canClaimComplete ? "yes" : "no"}`,
      'Do not claim the agent is live or say "Done." Explain that required capabilities are not connected.',
      'Preferred framing: "I can design this agent, but these capabilities are not currently connected."',
    ].join("\n")
  );
}

function claimsMissionComplete(text) {
  return (
    /\bdone\b/i.test(text) ||
    /\b(all set|you're all set|you are all set)\b/i.test(text) ||
    /\b(successfully (?:created|set up|configured)|finished setting up)\b/i.test(text)
  );
}

function claimsAgentLive(text) {
  return (
    /\b(is live|are live|now live|agent is (?:ready|active|running|set up))\b/i.test(text) ||
    /\b(created|set up|stood up|spun up)\b.{0,40}\b(agent|monitor|watcher)\b/i.test(text) ||
    /\byour\b.{0,40}\bagent\b.{0,40}\b(is live|is ready|is active)\b/i.test(text)
  );
}

function acknowledgesCapabilityGap(text) {
  return (
    /\b(not (?:currently )?connected|not available|unavailable|cannot|can't|do not (?:yet )?have|don't (?:yet )?have|missing|no .+ connector|capabilities? are not)\b/i.test(
      text
    ) || /\bi can design this agent\b/i.test(text)
  );
}

function claimsTradingLive(text) {
  return (
    /\b(trading agent|stock trading|brokerage)\b/i.test(text) &&
    (claimsMissionComplete(text) ||
      claimsAgentLive(text) ||
      /\b(will trade|can trade|execute trades)\b/i.test(text))
  );
}

function claimsSocialLive(text) {
  return (
    /\b(social media|instagram|tiktok|linkedin|\bx\b|twitter)\b/i.test(text) &&
    (claimsMissionComplete(text) ||
      claimsAgentLive(text) ||
      /\b(monitoring|tracking|reviewing)\b.{0,40}\b(posts?|feed)\b/i.test(text))
  );
}

export function looksLikeAgentCreationRequest(message) {
  return (
    /\b(create|build|set up|stand up|i(?:'d| would) like to create)\b/i.test(message || "") &&
    /\b(agent|monitor|trading|watcher)\b/i.test(message || "")
  );
}

function formatList(items) {
  if (!Array.isArray(items) || !items.length) return "(none)";
  return items.map((item) => String(item)).join(", ");
}

function uniqueStrings(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const key = String(item || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

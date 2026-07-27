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
// CEO control plane — intent ≠ execution, capability truth, execution state.
//
// Mirrors the identity architecture: authoritative structured state → Situation
// Brief sections → deterministic post-reply validation → optional regenerate.
// Prompt rules alone must not be the only guard against hallucinated "Done".
// ─────────────────────────────────────────────────────────────────────────────

export const CEO_INTENTS = Object.freeze({
  INFORMATION_REQUEST: "information_request",
  ONE_TIME_TASK: "one_time_task",
  RECURRING_MISSION: "recurring_mission",
  NEW_AGENT_CREATION: "new_agent_creation",
  AGENT_MODIFICATION: "agent_modification",
});

/**
 * Classify user intent separately from whether the system can execute it.
 */
export function classifyIntent(message, missionState = null) {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const kind = missionState?.missionKind || null;

  if (
    kind === "modify" ||
    missionState?.modifiesExisting ||
    (/\b(make my|change|update|rename|pause|resume|reschedule|tweak|edit)\b/i.test(text) &&
      /\b(agent|report|schedule|digest|reminder|brief)\b/i.test(text))
  ) {
    return CEO_INTENTS.AGENT_MODIFICATION;
  }

  if (
    kind === "create" ||
    kind === "execute" ||
    missionState?.createsNewCapability ||
    (/\b(create|build|set up|stand up)\b/i.test(lower) &&
      /\b(agent|bot|monitor|watcher)\b/i.test(lower)) ||
    /\b(i need an? agent|trading agent|monitoring agent)\b/i.test(lower)
  ) {
    // Recurring vs one-shot creation
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
    kind === "answer" ||
    kind === "clarify" ||
    (/\b(what|who|how|why|which|explain|tell me)\b/i.test(lower) &&
      !/\b(create|build|set up)\b/i.test(lower))
  ) {
    return CEO_INTENTS.INFORMATION_REQUEST;
  }

  if (
    /\b(run|check|look up|research|summarize|remind me)\b/i.test(lower) &&
    !/\b(create|build|set up|agents?)\b/i.test(lower)
  ) {
    return CEO_INTENTS.ONE_TIME_TASK;
  }

  return kind === "execute"
    ? CEO_INTENTS.ONE_TIME_TASK
    : CEO_INTENTS.INFORMATION_REQUEST;
}

/**
 * Full control-plane assessment for a turn: intent + required capabilities +
 * planned agent definition when creation is requested but blockers exist.
 */
export function assessControlPlaneRequest({
  message,
  missionState = null,
  platforms = null,
} = {}) {
  const intent = classifyIntent(message, missionState);
  const platformList =
    platforms ||
    detectPlatformNames(message) ||
    extractPlatformsFromKnown(missionState?.known);

  const required = resolveRequiredCapabilities({
    message,
    platforms: platformList,
    missionKind: missionState?.missionKind,
    tentativeAgentType: missionState?.tentativeAgentType,
  });

  const capabilityAssessment = assessCapabilities(required);
  const creationIntent =
    intent === CEO_INTENTS.NEW_AGENT_CREATION ||
    intent === CEO_INTENTS.RECURRING_MISSION;

  let plannedAgent = null;
  if (creationIntent) {
    plannedAgent = buildPlannedAgentDefinition({
      name: inferAgentName(message, missionState),
      type: missionState?.tentativeAgentType || null,
      purpose: missionState?.mission || String(message || "").slice(0, 200),
      requiredCapabilities: required,
      schedule: intent === CEO_INTENTS.RECURRING_MISSION ? { requested: true } : null,
    });
  }

  const systemAction = determineSystemAction({
    intent,
    capabilityAssessment,
    missionState,
  });

  return {
    intent,
    requiredCapabilities: required,
    capabilityAssessment,
    plannedAgent,
    systemAction,
    platforms: platformList,
  };
}

function determineSystemAction({ intent, capabilityAssessment, missionState }) {
  if (!capabilityAssessment.allAvailable) {
    return {
      possible: false,
      action: "explain_capability_gap",
      canClaimComplete: false,
      nextStep:
        "Design the agent definition and list missing connectors; do not claim the agent is live.",
    };
  }

  if (
    intent === CEO_INTENTS.NEW_AGENT_CREATION ||
    intent === CEO_INTENTS.RECURRING_MISSION
  ) {
    if (missionState?.missionExecutable) {
      return {
        possible: true,
        action: "create_agent",
        canClaimComplete: false, // only after tool confirms
        nextStep: "Call create_agent when execution facts are confirmed.",
      };
    }
    return {
      possible: true,
      action: "clarify_then_create",
      canClaimComplete: false,
      nextStep: "Ask the highest-value execution blocker, then create.",
    };
  }

  if (intent === CEO_INTENTS.AGENT_MODIFICATION) {
    return {
      possible: true,
      action: "update_agent",
      canClaimComplete: false,
      nextStep: "Call update_agent after confirming which agent to change.",
    };
  }

  if (intent === CEO_INTENTS.ONE_TIME_TASK) {
    return {
      possible: true,
      action: "run_or_answer",
      canClaimComplete: false,
      nextStep: "Delegate via run_agent or answer from tools/context.",
    };
  }

  return {
    possible: true,
    action: "answer",
    canClaimComplete: false,
    nextStep: "Answer from structured context; do not invent capabilities.",
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
} = {}) {
  const assessment = capabilityAssessment || assessCapabilities([]);
  const agent = turnState?.agent || null;
  const definition = agentDefinition || null;

  const objectCreated = Boolean(agent?.id);
  const agentRegistered = Boolean(agent?.id && agent?.agentType);
  const scheduleCreated = Boolean(
    agent?.schedule?.preset ||
      (definition?.schedule && definition.schedule !== null && definition.status === AGENT_DEFINITION_STATUS.ACTIVE)
  );
  const integrationsConnected = assessment.allAvailable;
  const dataSourceAvailable =
    assessment.allAvailable &&
    assessment.unavailable.length === 0 &&
    (assessment.required.length === 0 || assessment.available.length > 0);

  const creationIntent =
    intent === CEO_INTENTS.NEW_AGENT_CREATION ||
    intent === CEO_INTENTS.RECURRING_MISSION;

  const blockers = [...(assessment.blockers || [])];
  if (creationIntent && !assessment.allAvailable) {
    blockers.push("Required platform capabilities are not connected.");
  }
  if (creationIntent && assessment.allAvailable && !objectCreated) {
    blockers.push("Agent object not created yet.");
  }
  if (
    creationIntent &&
    intent === CEO_INTENTS.RECURRING_MISSION &&
    objectCreated &&
    !scheduleCreated
  ) {
    blockers.push("Schedule not created.");
  }

  const canClaimComplete =
    assessment.allAvailable &&
    (!creationIntent || (objectCreated && agentRegistered)) &&
    (intent !== CEO_INTENTS.RECURRING_MISSION || scheduleCreated || !creationIntent);

  return {
    objectCreated,
    agentRegistered,
    scheduleCreated,
    integrationsConnected,
    dataSourceAvailable,
    canClaimComplete,
    blockers: uniqueStrings(blockers),
    intent,
    agentId: agent?.id || definition?.id || null,
    agentStatus: definition?.status || (agent ? AGENT_DEFINITION_STATUS.ACTIVE : null),
  };
}

/**
 * Deterministic check: reject hallucinated completion claims.
 * Does not rely on prompt rules.
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
  const state =
    executionState ||
    buildExecutionState({ intent, capabilityAssessment: assessment });

  const claimsComplete = claimsMissionComplete(text);
  const claimsLiveAgent = claimsAgentLive(text);
  const acknowledgesGap = acknowledgesCapabilityGap(text);

  if (!assessment.allAvailable && (claimsComplete || claimsLiveAgent) && !acknowledgesGap) {
    failures.push("claimed_complete_without_capabilities");
  }

  if (
    (intent === CEO_INTENTS.NEW_AGENT_CREATION ||
      intent === CEO_INTENTS.RECURRING_MISSION ||
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

  // Specific unavailable domains mentioned as fulfilled.
  if (!assessment.allAvailable) {
    for (const cap of assessment.unavailable) {
      if (cap.id === "stock_trading" && claimsTradingLive(text) && !acknowledgesGap) {
        failures.push("claimed_trading_capability");
      }
      if (
        (cap.id === "social_media_monitoring" ||
          cap.id.endsWith("_connector")) &&
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
} = {}) {
  const sections = [
    dataSection(
      "PLATFORM CAPABILITIES (authoritative registry)",
      renderCapabilityRegistry(listCapabilities())
    ),
  ];

  if (controlPlane) {
    const assessment = controlPlane.capabilityAssessment || assessCapabilities([]);
    sections.push(
      dataSection(
        "CONTROL PLANE ASSESSMENT",
        [
          `intent: ${controlPlane.intent || "(unknown)"}`,
          `system_action: ${controlPlane.systemAction?.action || "(none)"}`,
          `action_possible: ${controlPlane.systemAction?.possible ? "yes" : "no"}`,
          `required_capabilities: ${formatList(controlPlane.requiredCapabilities)}`,
          `unavailable: ${formatList(assessment.unavailable.map((c) => c.id))}`,
          `blockers: ${formatList(assessment.blockers)}`,
          `next_step: ${controlPlane.systemAction?.nextStep || "(none)"}`,
          controlPlane.plannedAgent
            ? [
                "planned_agent:",
                `  name: ${controlPlane.plannedAgent.name || "(unnamed)"}`,
                `  type: ${controlPlane.plannedAgent.type || "(uncommitted)"}`,
                `  purpose: ${controlPlane.plannedAgent.purpose}`,
                `  status: ${controlPlane.plannedAgent.status}`,
                `  capabilities: ${formatList(controlPlane.plannedAgent.capabilities)}`,
                `  blockers: ${formatList(controlPlane.plannedAgent.blockers)}`,
              ].join("\n")
            : "planned_agent: (none)",
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
      `intent: ${controlPlane?.intent || "(unknown)"}`,
      `unavailable_capabilities: ${formatList(assessment.unavailable.map((c) => c.id))}`,
      `blockers: ${formatList(assessment.blockers)}`,
      `execution.can_claim_complete: ${executionState?.canClaimComplete ? "yes" : "no"}`,
      'Do not claim the agent is live or say "Done." Explain that required capabilities are not connected.',
      'Preferred framing: "I can design this agent, but these capabilities are not currently connected."',
      "Propose the next concrete step (connect integrations, or offer an available limited substitute clearly labeled as limited).",
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
    (claimsMissionComplete(text) || claimsAgentLive(text) || /\b(will trade|can trade|execute trades)\b/i.test(text))
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

function looksLikeAgentCreationRequest(message) {
  return /\b(create|build|set up|stand up)\b/i.test(message || "") &&
    /\b(agent|monitor|trading|watcher)\b/i.test(message || "");
}

function extractPlatformsFromKnown(known = []) {
  const platforms = [];
  for (const fact of known || []) {
    platforms.push(...detectPlatformNames(String(fact)));
  }
  return [...new Set(platforms)];
}

function inferAgentName(message, missionState) {
  if (/\bsocial\b/i.test(message || "") || /\bsocial\b/i.test(missionState?.mission || "")) {
    return "Social Media Review";
  }
  if (/\btrad(e|ing)\b/i.test(message || "")) return "Stock Trading";
  if (/\bcompetitor/i.test(message || "")) return "Competitor Watch";
  return null;
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

import { cronToSchedulePreset } from "./schedule.js";
import {
  assessCapabilities,
  isCapabilityAvailable,
} from "../capabilities/registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent definition model — agents are structured control-plane objects, not
// conversation prompts. Status reflects what the system actually registered.
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_DEFINITION_STATUS = Object.freeze({
  PLANNED: "planned",
  ACTIVE: "active",
  PAUSED: "paused",
  BLOCKED: "blocked",
});

/**
 * @typedef {object} AgentDefinition
 * @property {string|null} id
 * @property {string|null} type
 * @property {string} purpose
 * @property {string[]} capabilities
 * @property {string[]} tools
 * @property {string[]} permissions
 * @property {object|null} schedule
 * @property {"planned"|"active"|"paused"|"blocked"} status
 * @property {string[]} [blockers]
 * @property {string|null} [name]
 */

/**
 * Build a structured agent definition (never just a prompt string).
 * @param {Partial<AgentDefinition> & { purpose?: string }} input
 * @returns {AgentDefinition}
 */
export function buildAgentDefinition(input = {}) {
  const capabilityIds = uniqueStrings(input.capabilities || []);
  const assessment = assessCapabilities(capabilityIds);
  const unavailableIds = assessment.unavailable.map((cap) => cap.id);

  let status = normalizeStatus(input.status);
  if (!status) {
    if (unavailableIds.length && !input.id) status = AGENT_DEFINITION_STATUS.PLANNED;
    else if (unavailableIds.length) status = AGENT_DEFINITION_STATUS.BLOCKED;
    else if (input.id) status = AGENT_DEFINITION_STATUS.ACTIVE;
    else status = AGENT_DEFINITION_STATUS.PLANNED;
  }

  // Live/active only when every declared capability is actually available.
  if (
    (status === AGENT_DEFINITION_STATUS.ACTIVE ||
      status === AGENT_DEFINITION_STATUS.PAUSED) &&
    unavailableIds.length
  ) {
    status = AGENT_DEFINITION_STATUS.BLOCKED;
  }

  const tools = uniqueStrings([
    ...(input.tools || []),
    ...assessment.available.flatMap((cap) => cap.tools || []),
  ]);
  const permissions = uniqueStrings([
    ...(input.permissions || []),
    ...assessment.available.flatMap((cap) => cap.permissions || []),
  ]);

  return {
    id: input.id ?? null,
    type: input.type ?? null,
    name: input.name ?? null,
    purpose: String(input.purpose || "").trim() || "(unspecified)",
    capabilities: capabilityIds,
    tools,
    permissions,
    schedule: input.schedule ?? null,
    status,
    blockers: uniqueStrings([
      ...(input.blockers || []),
      ...assessment.blockers,
    ]),
  };
}

/**
 * Map a persisted AgentConfig row into the structured definition model.
 */
export function agentDefinitionFromConfig(config, { capabilityIds = [] } = {}) {
  if (!config) return null;
  const schedule = cronToSchedulePreset(config.schedule);
  const type = config.agentType || null;
  const inferredCaps = capabilityIds.length
    ? capabilityIds
    : defaultCapabilitiesForAgentType(type, config);

  const status =
    config.status === "PAUSED"
      ? AGENT_DEFINITION_STATUS.PAUSED
      : AGENT_DEFINITION_STATUS.ACTIVE;

  return buildAgentDefinition({
    id: config.id || null,
    type,
    name: config.name || null,
    purpose:
      config.definitionOfDone ||
      config.instructions ||
      `Run the ${type || "specialist"} agent.`,
    capabilities: inferredCaps,
    tools: toolsFromToolAccess(config.toolAccess),
    permissions: config.permissionLevel ? [config.permissionLevel] : ["READ_ONLY"],
    schedule,
    status,
  });
}

/**
 * Design-only definition when requested capabilities are not connected.
 * Never marks the agent as active/live.
 */
export function buildPlannedAgentDefinition({
  name = null,
  type = null,
  purpose = "",
  requiredCapabilities = [],
  schedule = null,
  tools = [],
  permissions = ["READ_ONLY"],
} = {}) {
  const assessment = assessCapabilities(requiredCapabilities);
  return buildAgentDefinition({
    id: null,
    type,
    name,
    purpose,
    capabilities: requiredCapabilities,
    tools,
    permissions,
    schedule,
    status: assessment.allAvailable
      ? AGENT_DEFINITION_STATUS.PLANNED
      : AGENT_DEFINITION_STATUS.PLANNED,
    blockers: assessment.blockers,
  });
}

export function defaultCapabilitiesForAgentType(agentType, config = null) {
  const caps = [];
  if (agentType === "finance") caps.push("finance_aggregates");
  if (agentType === "research") caps.push("web_research");
  if (agentType === "reminders") caps.push("reminders");
  if (config?.toolAccess?.email === true || config?.toolAccess?.includes?.("email")) {
    caps.push("email_delivery");
  }
  if (config?.schedule) caps.push("scheduling");
  return caps.filter((id) => isCapabilityAvailable(id) || id === "email_delivery" || id === "scheduling");
}

function toolsFromToolAccess(toolAccess) {
  if (!toolAccess) return [];
  if (Array.isArray(toolAccess)) return toolAccess.filter(Boolean);
  return Object.entries(toolAccess)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key);
}

function normalizeStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "active") return AGENT_DEFINITION_STATUS.ACTIVE;
  if (value === "paused") return AGENT_DEFINITION_STATUS.PAUSED;
  if (value === "planned") return AGENT_DEFINITION_STATUS.PLANNED;
  if (value === "blocked") return AGENT_DEFINITION_STATUS.BLOCKED;
  return null;
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

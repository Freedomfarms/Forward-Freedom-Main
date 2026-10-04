// CHIEF control plane — the catalog of governed operations.
//
// CapabilityPolicy and ToolExecutor remain the enforcement. This module is
// the list they draw from: what exists, what is reserved, and what cannot
// be registered. Repository mutation is forbidden here, not by a prompt.
//
// A live local tool must appear in this catalog and in CHIEF_TOOL_INVENTORY
// with the same capability. createChiefTools checks that. A forbidden
// operation has a tool name and no capability, so nothing can grant it.

import { Capability, isCapability } from "../core/capabilities.js";

export const ControlEffect = Object.freeze({
  READ: "read",
  CONFIRM: "confirm",
  FORBIDDEN: "forbidden",
});

export const ControlStatus = Object.freeze({
  LIVE: "live",
  RESERVED: "reserved",
  FORBIDDEN: "forbidden",
});

export const ControlDomain = Object.freeze({
  MEMORY: "memory",
  SCHEDULE: "schedule",
  FINANCE: "finance",
  SKILL: "skill",
  WEB: "web",
  MODULE: "module",
  CONVERSATION: "conversation",
  MESSAGE: "message",
  SETTINGS: "settings",
  WORKFLOW: "workflow",
  FILES: "files",
  SYSTEM: "system",
  INTEGRATION: "integration",
  WORKFORCE: "workforce",
  CODEBASE: "codebase",
  CONTROL: "control",
});

// Tool names that must never be constructable. They are not code execution;
// they are repository mutation. code:execute stays banned in inventory.js.
const FORBIDDEN_TOOLS = Object.freeze([
  "codebase_write",
  "source_write",
  "repository_write",
  "git_add",
  "git_commit",
  "git_push",
  "deploy",
]);

// Strings that must never become Capability labels or requiredCapabilities.
const FORBIDDEN_CAPABILITIES = Object.freeze([
  "codebase:write",
  "source:write",
  "repository:write",
  "git:commit",
  "git:push",
  "git:add",
  "deploy",
]);

function operation(fields) {
  return Object.freeze({
    id: fields.id,
    domain: fields.domain,
    effect: fields.effect,
    status: fields.status,
    capability: fields.capability ?? null,
    tool: fields.tool ?? null,
    remote: fields.remote === true,
    baseline: fields.baseline === true,
  });
}

const live = (fields) =>
  operation({
    ...fields,
    status: ControlStatus.LIVE,
    baseline: fields.baseline !== false,
  });

const reserved = (fields) =>
  operation({
    ...fields,
    status: ControlStatus.RESERVED,
    tool: null,
    baseline: false,
    remote: false,
  });

const forbidden = (fields) =>
  operation({
    ...fields,
    effect: ControlEffect.FORBIDDEN,
    status: ControlStatus.FORBIDDEN,
    capability: null,
    baseline: false,
    remote: false,
  });

// Order of baseline: true entries defines baselineCapabilities().
// That order is the empty-grant list and must stay stable.
export const CONTROL_PLANE = Object.freeze([
  live({
    id: "memory.read",
    domain: ControlDomain.MEMORY,
    effect: ControlEffect.READ,
    capability: Capability.MEMORY_READ,
    tool: "memory_read",
  }),
  live({
    id: "memory.write",
    domain: ControlDomain.MEMORY,
    effect: ControlEffect.CONFIRM,
    capability: Capability.MEMORY_WRITE,
    tool: "memory_write",
  }),
  live({
    id: "memory.kg_lookup",
    domain: ControlDomain.MEMORY,
    effect: ControlEffect.READ,
    capability: Capability.MEMORY_READ,
    tool: "kg_lookup",
  }),
  live({
    id: "memory.kg_link",
    domain: ControlDomain.MEMORY,
    effect: ControlEffect.CONFIRM,
    capability: Capability.MEMORY_WRITE,
    tool: "kg_link",
  }),
  live({
    id: "memory.handoff",
    domain: ControlDomain.MEMORY,
    effect: ControlEffect.CONFIRM,
    capability: Capability.MEMORY_WRITE,
    tool: "write_handoff",
  }),
  live({
    id: "schedule.create",
    domain: ControlDomain.SCHEDULE,
    effect: ControlEffect.CONFIRM,
    capability: Capability.SCHEDULE_CREATE,
    tool: "schedule_create",
  }),
  live({
    id: "schedule.list",
    domain: ControlDomain.SCHEDULE,
    effect: ControlEffect.READ,
    capability: Capability.SCHEDULE_READ,
    tool: "schedule_list",
  }),
  live({
    id: "schedule.pause",
    domain: ControlDomain.SCHEDULE,
    effect: ControlEffect.CONFIRM,
    capability: Capability.SCHEDULE_CREATE,
    tool: "schedule_pause",
  }),
  live({
    id: "schedule.resume",
    domain: ControlDomain.SCHEDULE,
    effect: ControlEffect.CONFIRM,
    capability: Capability.SCHEDULE_CREATE,
    tool: "schedule_resume",
  }),
  live({
    id: "schedule.cancel",
    domain: ControlDomain.SCHEDULE,
    effect: ControlEffect.CONFIRM,
    capability: Capability.SCHEDULE_CREATE,
    tool: "schedule_cancel",
  }),
  live({
    id: "schedule.update",
    domain: ControlDomain.SCHEDULE,
    effect: ControlEffect.CONFIRM,
    capability: Capability.SCHEDULE_CREATE,
    tool: "schedule_update",
  }),
  live({
    id: "schedule.outcome",
    domain: ControlDomain.SCHEDULE,
    effect: ControlEffect.READ,
    capability: Capability.SCHEDULE_READ,
    tool: "schedule_outcome",
  }),
  live({
    id: "schedule.runs",
    domain: ControlDomain.SCHEDULE,
    effect: ControlEffect.READ,
    capability: Capability.SCHEDULE_READ,
    tool: "schedule_runs",
  }),
  live({
    id: "finance.summary",
    domain: ControlDomain.FINANCE,
    effect: ControlEffect.READ,
    capability: Capability.FINANCE_READ,
    tool: "finance_summary",
  }),
  live({
    id: "finance.workspace",
    domain: ControlDomain.FINANCE,
    effect: ControlEffect.READ,
    capability: Capability.FINANCE_READ,
    tool: "workspace_plan_summary",
  }),
  live({
    id: "skill.view",
    domain: ControlDomain.SKILL,
    effect: ControlEffect.READ,
    capability: Capability.SKILL_READ,
    tool: "skill_view",
  }),
  live({
    id: "web.search",
    domain: ControlDomain.WEB,
    effect: ControlEffect.READ,
    capability: Capability.WEB_SEARCH,
    tool: "web_search",
  }),
  live({
    id: "module.access_status",
    domain: ControlDomain.MODULE,
    effect: ControlEffect.READ,
    capability: Capability.MODULE_ACCESS,
    tool: "module02_access_status",
  }),
  live({
    id: "module.access_set",
    domain: ControlDomain.MODULE,
    effect: ControlEffect.CONFIRM,
    capability: Capability.MODULE_ACCESS,
    tool: "module02_access_set",
  }),
  live({
    id: "conversation.search",
    domain: ControlDomain.CONVERSATION,
    effect: ControlEffect.READ,
    capability: Capability.CONVERSATION_READ,
    tool: "conversation_search",
  }),
  live({
    id: "conversation.retrieve",
    domain: ControlDomain.CONVERSATION,
    effect: ControlEffect.READ,
    capability: Capability.CONVERSATION_READ,
    tool: "conversation_retrieve",
  }),
  live({
    id: "conversation.rename",
    domain: ControlDomain.CONVERSATION,
    effect: ControlEffect.CONFIRM,
    capability: Capability.CONVERSATION_WRITE,
    tool: "conversation_rename",
  }),
  live({
    id: "conversation.archive",
    domain: ControlDomain.CONVERSATION,
    effect: ControlEffect.CONFIRM,
    capability: Capability.CONVERSATION_WRITE,
    tool: "conversation_archive",
  }),
  live({
    id: "conversation.restore",
    domain: ControlDomain.CONVERSATION,
    effect: ControlEffect.CONFIRM,
    capability: Capability.CONVERSATION_WRITE,
    tool: "conversation_restore",
  }),
  live({
    id: "conversation.delete",
    domain: ControlDomain.CONVERSATION,
    effect: ControlEffect.CONFIRM,
    capability: Capability.CONVERSATION_DELETE,
    tool: "conversation_delete",
  }),
  live({
    id: "settings.read",
    domain: ControlDomain.SETTINGS,
    effect: ControlEffect.READ,
    capability: Capability.SETTINGS_READ,
    tool: "settings_read",
  }),
  live({
    id: "settings.update",
    domain: ControlDomain.SETTINGS,
    effect: ControlEffect.CONFIRM,
    capability: Capability.SETTINGS_WRITE,
    tool: "settings_update",
  }),
  live({
    id: "control.discover",
    domain: ControlDomain.CONTROL,
    effect: ControlEffect.READ,
    capability: Capability.CAPABILITY_READ,
    tool: "capability_discover",
  }),
  live({
    id: "code.tree",
    domain: ControlDomain.CODEBASE,
    effect: ControlEffect.READ,
    capability: Capability.CODE_READ,
    tool: "code_tree",
  }),
  live({
    id: "code.read",
    domain: ControlDomain.CODEBASE,
    effect: ControlEffect.READ,
    capability: Capability.CODE_READ,
    tool: "code_read",
  }),
  live({
    id: "code.search",
    domain: ControlDomain.CODEBASE,
    effect: ControlEffect.READ,
    capability: Capability.CODE_READ,
    tool: "code_search",
  }),
  live({
    id: "integration.mcp_invoke",
    domain: ControlDomain.INTEGRATION,
    effect: ControlEffect.CONFIRM,
    capability: Capability.TOOL_INVOKE,
    tool: "mcp_invoke",
    remote: true,
    baseline: false,
  }),

  reserved({
    id: "message.read",
    domain: ControlDomain.MESSAGE,
    effect: ControlEffect.READ,
  }),
  reserved({
    id: "workflow.inspect",
    domain: ControlDomain.WORKFLOW,
    effect: ControlEffect.READ,
  }),
  reserved({
    id: "files.read",
    domain: ControlDomain.FILES,
    effect: ControlEffect.READ,
    capability: Capability.FILE_READ,
  }),
  reserved({
    id: "system.inspect",
    domain: ControlDomain.SYSTEM,
    effect: ControlEffect.READ,
  }),
  reserved({
    id: "workforce.observe",
    domain: ControlDomain.WORKFORCE,
    effect: ControlEffect.READ,
    capability: Capability.WORKFORCE_READ,
  }),

  forbidden({ id: "codebase.write", domain: ControlDomain.CODEBASE, tool: "codebase_write" }),
  forbidden({ id: "codebase.source_write", domain: ControlDomain.CODEBASE, tool: "source_write" }),
  forbidden({
    id: "codebase.repository_write",
    domain: ControlDomain.CODEBASE,
    tool: "repository_write",
  }),
  forbidden({ id: "codebase.git_add", domain: ControlDomain.CODEBASE, tool: "git_add" }),
  forbidden({ id: "codebase.git_commit", domain: ControlDomain.CODEBASE, tool: "git_commit" }),
  forbidden({ id: "codebase.git_push", domain: ControlDomain.CODEBASE, tool: "git_push" }),
  forbidden({ id: "codebase.deploy", domain: ControlDomain.CODEBASE, tool: "deploy" }),
]);

export function baselineCapabilities() {
  const labels = [];
  for (const entry of CONTROL_PLANE) {
    if (!entry.baseline || !entry.capability) continue;
    if (!labels.includes(entry.capability)) labels.push(entry.capability);
  }
  return labels;
}

export function isForbiddenControlTool(name) {
  return FORBIDDEN_TOOLS.includes(name);
}

export function isForbiddenControlCapability(label) {
  return FORBIDDEN_CAPABILITIES.includes(label);
}

export function assertControlPlane(inventory) {
  const ids = new Set();
  const tools = new Set();
  for (const entry of CONTROL_PLANE) {
    if (ids.has(entry.id)) throw new Error(`duplicate control-plane id '${entry.id}'`);
    ids.add(entry.id);
    if (entry.tool) {
      if (tools.has(entry.tool)) throw new Error(`duplicate control-plane tool '${entry.tool}'`);
      tools.add(entry.tool);
    }
    if (entry.domain === ControlDomain.CODEBASE && entry.effect === ControlEffect.CONFIRM) {
      throw new Error(`codebase operation '${entry.id}' cannot confirm a write`);
    }
    if (entry.capability && isForbiddenControlCapability(entry.capability)) {
      throw new Error(`control plane cannot grant '${entry.capability}'`);
    }
    if (entry.status === ControlStatus.FORBIDDEN) {
      if (entry.capability) throw new Error(`forbidden operation '${entry.id}' has a capability`);
      if (entry.baseline) throw new Error(`forbidden operation '${entry.id}' is on the baseline`);
      if (!isForbiddenControlTool(entry.tool)) {
        throw new Error(`forbidden operation '${entry.id}' is missing its tool ban`);
      }
    }
    if (entry.status === ControlStatus.RESERVED) {
      if (entry.tool) throw new Error(`reserved operation '${entry.id}' must not have a tool`);
      if (entry.baseline) throw new Error(`reserved operation '${entry.id}' is on the baseline`);
    }
    if (entry.status === ControlStatus.LIVE) {
      if (!entry.tool || !entry.capability) {
        throw new Error(`live operation '${entry.id}' needs a tool and a capability`);
      }
      if (!isCapability(entry.capability)) {
        throw new Error(`live operation '${entry.id}' has an unknown capability`);
      }
    }
    if (entry.baseline && (entry.remote || entry.status !== ControlStatus.LIVE)) {
      throw new Error(`baseline operation '${entry.id}' must be a live local tool`);
    }
  }

  for (const name of FORBIDDEN_TOOLS) {
    if (
      !CONTROL_PLANE.some(
        (entry) => entry.tool === name && entry.effect === ControlEffect.FORBIDDEN
      )
    ) {
      throw new Error(`forbidden tool '${name}' has no catalog row`);
    }
  }

  const liveLocal = CONTROL_PLANE.filter(
    (entry) => entry.status === ControlStatus.LIVE && !entry.remote
  );
  const catalogNames = liveLocal.map((entry) => entry.tool).sort();
  const inventoryNames = Object.keys(inventory ?? {}).sort();
  if (catalogNames.join("\0") !== inventoryNames.join("\0")) {
    throw new Error("control plane and tool inventory name sets differ");
  }
  for (const entry of liveLocal) {
    const floor = inventory[entry.tool];
    if (!Array.isArray(floor) || floor.length !== 1 || floor[0] !== entry.capability) {
      throw new Error(`inventory floor for '${entry.tool}' does not match the control plane`);
    }
  }
  return true;
}

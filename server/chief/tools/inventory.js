// CHIEF tool inventory — the capability floor for tools this process ships.
//
// Not a copy of OpenJarvis DEFAULT_TOOL_CAPABILITIES (that list includes
// shell_exec, repl, code_interpreter, and docker_shell_exec). An inventoried
// name uses this table. An uninventoried in-tree name still fails closed as
// system:admin via canonicalToolCapabilities. Remote tools do not appear
// here: their floor is tool:invoke, decided by the remote flag, so an MCP
// server cannot impersonate a reviewed local tool by name.

import { Capability } from "../core/capabilities.js";
import { isForbiddenControlCapability, isForbiddenControlTool } from "../control/plane.js";

export const CHIEF_TOOL_INVENTORY = Object.freeze({
  memory_read: Object.freeze([Capability.MEMORY_READ]),
  memory_write: Object.freeze([Capability.MEMORY_WRITE]),
  write_handoff: Object.freeze([Capability.MEMORY_WRITE]),
  kg_lookup: Object.freeze([Capability.MEMORY_READ]),
  kg_link: Object.freeze([Capability.MEMORY_WRITE]),
  schedule_create: Object.freeze([Capability.SCHEDULE_CREATE]),
  schedule_list: Object.freeze([Capability.SCHEDULE_READ]),
  schedule_pause: Object.freeze([Capability.SCHEDULE_CREATE]),
  schedule_resume: Object.freeze([Capability.SCHEDULE_CREATE]),
  schedule_cancel: Object.freeze([Capability.SCHEDULE_CREATE]),
  schedule_update: Object.freeze([Capability.SCHEDULE_CREATE]),
  schedule_runs: Object.freeze([Capability.SCHEDULE_READ]),
  schedule_outcome: Object.freeze([Capability.SCHEDULE_READ]),
  finance_summary: Object.freeze([Capability.FINANCE_READ]),
  workspace_plan_summary: Object.freeze([Capability.FINANCE_READ]),
  freedom_financial_access_status: Object.freeze([Capability.MODULE_ACCESS]),
  freedom_financial_access_set: Object.freeze([Capability.MODULE_ACCESS]),
  skill_view: Object.freeze([Capability.SKILL_READ]),
  web_search: Object.freeze([Capability.WEB_SEARCH]),
  conversation_search: Object.freeze([Capability.CONVERSATION_READ]),
  conversation_retrieve: Object.freeze([Capability.CONVERSATION_READ]),
  conversation_rename: Object.freeze([Capability.CONVERSATION_WRITE]),
  conversation_archive: Object.freeze([Capability.CONVERSATION_WRITE]),
  conversation_restore: Object.freeze([Capability.CONVERSATION_WRITE]),
  conversation_delete: Object.freeze([Capability.CONVERSATION_DELETE]),
  settings_read: Object.freeze([Capability.SETTINGS_READ]),
  settings_update: Object.freeze([Capability.SETTINGS_WRITE]),
  code_tree: Object.freeze([Capability.CODE_READ]),
  code_read: Object.freeze([Capability.CODE_READ]),
  code_search: Object.freeze([Capability.CODE_READ]),
  capability_discover: Object.freeze([Capability.CAPABILITY_READ]),
});

// Scheduled turns do not search or manage the user's conversations.
export const SCHEDULED_TURN_EXCLUDED_TOOLS = Object.freeze([
  "conversation_search",
  "conversation_retrieve",
  "conversation_rename",
  "conversation_archive",
  "conversation_restore",
  "conversation_delete",
]);

export const FORBIDDEN_TOOL_NAMES = Object.freeze([
  "shell_exec",
  "repl",
  "code_interpreter",
  "docker_shell_exec",
  "bash",
  "code_execute",
]);

export function inventoryFromTools(tools, base = CHIEF_TOOL_INVENTORY) {
  const inventory = { ...base };
  for (const tool of tools ?? []) {
    const name = tool?.spec?.name;
    if (!name || Object.hasOwn(inventory, name)) continue;
    inventory[name] = Object.freeze([...(tool.spec.requiredCapabilities ?? [])]);
  }
  return Object.freeze(inventory);
}

export function assertToolAllowed(spec) {
  if (FORBIDDEN_TOOL_NAMES.includes(spec?.name)) {
    throw new Error(`code-execution tool '${spec.name}' is not allowed`);
  }
  if (isForbiddenControlTool(spec?.name)) {
    throw new Error(`tool '${spec.name}' is not allowed by the control plane`);
  }
  const required = spec?.requiredCapabilities ?? [];
  if (required.includes(Capability.CODE_EXECUTE)) {
    throw new Error(`tool '${spec?.name}' cannot require code:execute`);
  }
  for (const label of required) {
    if (isForbiddenControlCapability(label)) {
      throw new Error(`tool '${spec?.name}' cannot require ${label}`);
    }
  }
}

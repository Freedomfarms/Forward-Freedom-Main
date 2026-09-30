// CHIEF tool inventory — the capability floor for tools this process ships.
//
// Not a copy of OpenJarvis DEFAULT_TOOL_CAPABILITIES (that list includes
// shell_exec, repl, code_interpreter, and docker_shell_exec). An inventoried
// name uses this table. An uninventoried in-tree name still fails closed as
// system:admin via canonicalToolCapabilities. Remote tools do not appear
// here: their floor is tool:invoke, decided by the remote flag, so an MCP
// server cannot impersonate a reviewed local tool by name.

import { Capability } from "../core/capabilities.js";

export const CHIEF_TOOL_INVENTORY = Object.freeze({
  memory_read: Object.freeze([Capability.MEMORY_READ]),
  memory_write: Object.freeze([Capability.MEMORY_WRITE]),
  write_handoff: Object.freeze([Capability.MEMORY_WRITE]),
  kg_lookup: Object.freeze([Capability.MEMORY_READ]),
  kg_link: Object.freeze([Capability.MEMORY_WRITE]),
  schedule_create: Object.freeze([Capability.SCHEDULE_CREATE]),
  schedule_list: Object.freeze([Capability.SCHEDULE_CREATE]),
  schedule_pause: Object.freeze([Capability.SCHEDULE_CREATE]),
  schedule_resume: Object.freeze([Capability.SCHEDULE_CREATE]),
  schedule_cancel: Object.freeze([Capability.SCHEDULE_CREATE]),
  finance_summary: Object.freeze([Capability.FINANCE_READ]),
  workspace_plan_summary: Object.freeze([Capability.FINANCE_READ]),
  skill_view: Object.freeze([Capability.SKILL_READ]),
});

export const FORBIDDEN_TOOL_NAMES = Object.freeze([
  "shell_exec",
  "repl",
  "code_interpreter",
  "docker_shell_exec",
  "bash",
  "code_execute",
]);

export function assertToolAllowed(spec) {
  if (FORBIDDEN_TOOL_NAMES.includes(spec?.name)) {
    throw new Error(`code-execution tool '${spec.name}' is not allowed`);
  }
  if ((spec?.requiredCapabilities ?? []).includes(Capability.CODE_EXECUTE)) {
    throw new Error(`tool '${spec?.name}' cannot require code:execute`);
  }
}

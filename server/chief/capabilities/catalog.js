// Governance metadata for capabilities CHIEF already implements.
// Handlers stay in the subsystem modules. This table does not execute anything.

import { AuditPolicy, Confirmation, Effect, Exposure } from "./descriptor.js";

const STRING_OUTPUT = Object.freeze({ type: "string" });

function entry(subsystem, effect, confirmation, audit, exposure = Exposure.BASELINE) {
  return Object.freeze({
    subsystem,
    effect,
    confirmation,
    audit,
    exposure,
    outputSchema: STRING_OUTPUT,
  });
}

export const CAPABILITY_CATALOG = Object.freeze({
  memory_read: entry("memory", Effect.READ, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  memory_write: entry("memory", Effect.WRITE, Confirmation.REQUIRED, AuditPolicy.DENY_ONLY),
  kg_lookup: entry("memory", Effect.READ, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  kg_link: entry("memory", Effect.WRITE, Confirmation.REQUIRED, AuditPolicy.DENY_ONLY),
  write_handoff: entry("memory", Effect.WRITE, Confirmation.REQUIRED, AuditPolicy.DENY_ONLY),
  schedule_create: entry("scheduler", Effect.WRITE, Confirmation.REQUIRED, AuditPolicy.DENY_ONLY),
  schedule_list: entry("scheduler", Effect.READ, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  schedule_update: entry("scheduler", Effect.WRITE, Confirmation.REQUIRED, AuditPolicy.DENY_ONLY),
  schedule_pause: entry("scheduler", Effect.WRITE, Confirmation.REQUIRED, AuditPolicy.DENY_ONLY),
  schedule_resume: entry("scheduler", Effect.WRITE, Confirmation.REQUIRED, AuditPolicy.DENY_ONLY),
  schedule_cancel: entry("scheduler", Effect.DESTRUCTIVE, Confirmation.REQUIRED, AuditPolicy.FULL),
  schedule_runs: entry("scheduler", Effect.READ, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  schedule_outcome: entry("scheduler", Effect.READ, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  finance_summary: entry("finance", Effect.READ, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  workspace_plan_summary: entry("finance", Effect.READ, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  module02_access_status: entry("settings", Effect.READ, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  module02_access_set: entry(
    "settings",
    Effect.HIGH_IMPACT,
    Confirmation.REQUIRED,
    AuditPolicy.FULL
  ),
  skill_view: entry("skills", Effect.READ, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  web_search: entry("web", Effect.EXTERNAL, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  mcp_invoke: entry("mcp", Effect.EXTERNAL, Confirmation.REQUIRED, AuditPolicy.DENY_ONLY),
  conversation_search: entry(
    "conversations",
    Effect.READ,
    Confirmation.NONE,
    AuditPolicy.DENY_ONLY
  ),
  conversation_retrieve: entry(
    "conversations",
    Effect.READ,
    Confirmation.NONE,
    AuditPolicy.DENY_ONLY
  ),
  conversation_rename: entry(
    "conversations",
    Effect.WRITE,
    Confirmation.REQUIRED,
    AuditPolicy.DENY_ONLY
  ),
  conversation_archive: entry(
    "conversations",
    Effect.WRITE,
    Confirmation.REQUIRED,
    AuditPolicy.DENY_ONLY
  ),
  conversation_restore: entry(
    "conversations",
    Effect.WRITE,
    Confirmation.REQUIRED,
    AuditPolicy.DENY_ONLY
  ),
  conversation_delete: entry(
    "conversations",
    Effect.DESTRUCTIVE,
    Confirmation.REQUIRED,
    AuditPolicy.FULL
  ),
  settings_read: entry("settings", Effect.READ, Confirmation.NONE, AuditPolicy.DENY_ONLY),
  settings_update: entry("settings", Effect.WRITE, Confirmation.REQUIRED, AuditPolicy.DENY_ONLY),
  code_tree: entry(
    "code",
    Effect.READ,
    Confirmation.NONE,
    AuditPolicy.DENY_ONLY,
    Exposure.ON_DEMAND
  ),
  code_read: entry(
    "code",
    Effect.READ,
    Confirmation.NONE,
    AuditPolicy.DENY_ONLY,
    Exposure.ON_DEMAND
  ),
  code_search: entry(
    "code",
    Effect.READ,
    Confirmation.NONE,
    AuditPolicy.DENY_ONLY,
    Exposure.ON_DEMAND
  ),
});

export function catalogEntry(name) {
  return CAPABILITY_CATALOG[name] ?? null;
}

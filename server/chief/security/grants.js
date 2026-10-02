// Load chief_capability_grant rows into the existing CapabilityPolicy.
// Enforcement stays fail-closed: defaultDeny, and a load failure must not
// become an open policy.
//
// Zero rows are not an explicit policy. OpenJarvis setup_security grants a
// narrow _default set when no policy file is configured, so default-deny
// does not leave every tool unreachable. This loader grants only the
// capabilities the CHIEF inventory already uses, including web:search,
// module:access, conversation:read, conversation:write, conversation:delete,
// schedule:read, settings:read, and settings:write. network:fetch, file:read,
// and code:read stay off the baseline.
// finance:read lets the read tools run so they can report that Module 02
// access is off. The data
// itself stays behind chief_module_access, which defaults to off and is not
// a grant row. Any returned grant row replaces this baseline.
// policyFromGrantRows stays a pure mapping of stored rows.

import { withUserContext } from "../../db/prisma.js";
import { Capability, CapabilityPolicy } from "../core/capabilities.js";

const BASELINE_CAPABILITIES = Object.freeze([
  Capability.MEMORY_READ,
  Capability.MEMORY_WRITE,
  Capability.SCHEDULE_CREATE,
  Capability.SCHEDULE_READ,
  Capability.FINANCE_READ,
  Capability.SKILL_READ,
  Capability.WEB_SEARCH,
  Capability.MODULE_ACCESS,
  Capability.CONVERSATION_READ,
  Capability.CONVERSATION_WRITE,
  Capability.CONVERSATION_DELETE,
  Capability.SETTINGS_READ,
  Capability.SETTINGS_WRITE,
]);

function baselinePolicy() {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  for (const capability of BASELINE_CAPABILITIES) {
    policy.grant("_default", capability);
  }
  return policy;
}

export function policyFromGrantRows(rows, { defaultDeny = true } = {}) {
  const byAgent = new Map();
  for (const row of rows ?? []) {
    if (typeof row?.agentId !== "string" || row.agentId.trim() === "") {
      throw new Error("capability grant agentId must be a nonempty string");
    }
    if (typeof row.capability !== "string" || row.capability.trim() === "") {
      throw new Error("capability grant capability must be a nonempty string");
    }
    if (!byAgent.has(row.agentId)) {
      byAgent.set(row.agentId, { agent_id: row.agentId, grants: [], deny: [] });
    }
    const agent = byAgent.get(row.agentId);
    if (row.deny) agent.deny.push(row.capability);
    else agent.grants.push({ capability: row.capability, pattern: row.pattern || "*" });
  }
  if (byAgent.size === 0) return new CapabilityPolicy({ defaultDeny });
  return new CapabilityPolicy({
    defaultDeny,
    policyDocument: { agents: [...byAgent.values()] },
  });
}

export function closedPolicy() {
  return new CapabilityPolicy({ defaultDeny: true });
}

export async function loadCapabilityPolicy(userId, { withUser = withUserContext } = {}) {
  const rows = await withUser(userId, (tx) =>
    tx.chiefCapabilityGrant.findMany({ where: { userId } })
  );
  if (!rows || rows.length === 0) return baselinePolicy();
  return policyFromGrantRows(rows);
}

// Load chief_capability_grant rows into the existing CapabilityPolicy.
// Enforcement stays fail-closed: defaultDeny, and a load failure must not
// become an open policy.

import { withUserContext } from "../../db/prisma.js";
import { CapabilityPolicy } from "../core/capabilities.js";

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
  return policyFromGrantRows(rows);
}

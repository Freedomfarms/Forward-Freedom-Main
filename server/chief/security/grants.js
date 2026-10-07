// Load chief_capability_grant rows into the existing CapabilityPolicy.
// Enforcement stays fail-closed: defaultDeny, and a load failure must not
// become an open policy.
//
// Zero rows are not an explicit policy. OpenJarvis setup_security grants a
// narrow _default set when no policy file is configured, so default-deny
// does not leave every tool unreachable. The built-in baseline is
// baselineCapabilities() in the control-plane catalog. That list includes
// the ordinary reads, including capability:read and code:read. workforce:read
// stays off it. network:fetch, file:read, file:write, and code:execute stay
// off it. A connected connector adds its own grants on top. A disconnected
// connector adds none. code:read is the configured repository, not a user
// GitHub account and not a shell.
// finance:read lets the read tools run so they can report that Freedom Financial
// access is off. The data itself stays behind chief_module_access, which
// defaults to off and is not a grant row. Stored rows merge onto this
// baseline. An explicit deny still removes that capability.
// policyFromGrantRows stays a pure mapping of stored rows and does not merge.

import { withUserContext } from "../../db/prisma.js";
import { defaultConnectors } from "../connectors/registry.js";
import { CapabilityPolicy, isCapability } from "../core/capabilities.js";
import { baselineCapabilities } from "../control/plane.js";

const BASELINE_CAPABILITIES = Object.freeze(baselineCapabilities());

function baselinePolicy(connectors = defaultConnectors()) {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  const granted = new Set(BASELINE_CAPABILITIES);
  for (const connector of connectors) {
    if (connector?.connected !== true) continue;
    for (const capability of connector.capabilities ?? []) {
      if (typeof capability.grant === "string" && capability.grant) granted.add(capability.grant);
    }
  }
  for (const capability of granted) {
    policy.grant("_default", capability);
  }
  return policy;
}

function assertGrantRow(row) {
  if (typeof row?.agentId !== "string" || row.agentId.trim() === "") {
    throw new Error("capability grant agentId must be a nonempty string");
  }
  if (typeof row.capability !== "string" || row.capability.trim() === "") {
    throw new Error("capability grant capability must be a nonempty string");
  }
}

export function policyFromGrantRows(rows, { defaultDeny = true } = {}) {
  const byAgent = new Map();
  for (const row of rows ?? []) {
    assertGrantRow(row);
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

// CapabilityPolicy does not inherit `_default` once an agent has its own
// rows. Copy the baseline onto those agents, then add stored grants and
// apply stored denies. A deny on `_default` is copied too, so an explicit
// deny still wins after that agent stops inheriting.
function mergeStoredGrants(policy, rows) {
  for (const row of rows) assertGrantRow(row);
  const baseline = policy.listGrants("_default");
  const shadowed = new Set();
  for (const row of rows) {
    if (row.agentId !== "_default") shadowed.add(row.agentId);
  }
  for (const agentId of shadowed) {
    for (const grant of baseline) {
      policy.grant(agentId, grant.capability, grant.pattern);
    }
  }
  const defaultDenies = [];
  for (const row of rows) {
    if (row.deny) {
      policy.deny(row.agentId, row.capability);
      if (row.agentId === "_default") defaultDenies.push(row.capability);
    } else {
      policy.grant(row.agentId, row.capability, row.pattern || "*");
    }
  }
  for (const agentId of shadowed) {
    for (const capability of defaultDenies) policy.deny(agentId, capability);
  }
  return policy;
}

export function closedPolicy() {
  return new CapabilityPolicy({ defaultDeny: true });
}

// Writes one row in chief_capability_grant. It does not change the baseline.
// A later load merges this row onto that baseline. deny true removes it.
export async function saveCapabilityGrant(
  tx,
  userId,
  { agentId = "_default", capability, pattern = "*", deny = false } = {}
) {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("capability grant requires a user");
  }
  if (!isCapability(capability)) throw new Error("unknown capability");
  if (typeof agentId !== "string" || agentId.trim() === "") {
    throw new Error("capability grant agentId must be a nonempty string");
  }
  if (typeof pattern !== "string" || pattern.trim() === "") {
    throw new Error("capability grant pattern must be a nonempty string");
  }
  const where = { userId, agentId, capability };
  const existing = await tx.chiefCapabilityGrant.findFirst({ where });
  const data = { pattern, deny: deny === true };
  if (existing) {
    return tx.chiefCapabilityGrant.update({ where: { id: existing.id }, data });
  }
  return tx.chiefCapabilityGrant.create({ data: { ...where, ...data } });
}

export async function loadCapabilityPolicy(
  userId,
  { withUser = withUserContext, connectors } = {}
) {
  const rows = await withUser(userId, (tx) =>
    tx.chiefCapabilityGrant.findMany({ where: { userId } })
  );
  const policy = baselinePolicy(connectors);
  if (!rows || rows.length === 0) return policy;
  return mergeStoredGrants(policy, rows);
}

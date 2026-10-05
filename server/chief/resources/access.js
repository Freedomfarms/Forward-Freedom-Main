// Read dispatch for CHIEF.
//
// A capability grant names what this user may read. This module is the
// retrieval gate in front of the adapter that actually loads the resource.
// It does not grant capabilities, open a database, or perform writes.

import { Capability } from "../core/capabilities.js";

export const READ_RESOURCES = Object.freeze({
  code: Object.freeze({
    capability: Capability.CODE_READ,
    operations: Object.freeze({
      list: "code_tree",
      get: "code_read",
      query: "code_search",
    }),
  }),
  finance: Object.freeze({
    capability: Capability.FINANCE_READ,
    operations: Object.freeze({
      get: "finance_summary",
    }),
  }),
  conversations: Object.freeze({
    capability: Capability.CONVERSATION_READ,
    operations: Object.freeze({
      list: "conversation_search",
      query: "conversation_search",
      get: "conversation_retrieve",
    }),
  }),
});

export function readResourceDefinition(resource) {
  return READ_RESOURCES[resource] ?? null;
}

export async function readResource({
  resource,
  operation,
  policy = null,
  agentId = "chief",
  retrieve,
  params,
} = {}) {
  const entry = readResourceDefinition(resource);
  const tool = entry?.operations?.[operation];
  if (!entry || !tool) return { isError: true, error: "unknown read" };
  if (policy && typeof policy.check === "function") {
    if (policy.check(agentId || "chief", entry.capability, tool) !== true) {
      return { isError: true, error: `Capability '${entry.capability}' denied` };
    }
  }
  if (typeof retrieve !== "function")
    return { isError: true, error: "resource is not retrievable" };
  return retrieve(params);
}

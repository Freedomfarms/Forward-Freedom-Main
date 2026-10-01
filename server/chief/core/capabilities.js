// CHIEF core capabilities — RBAC capability model for tool dispatch.
//
// PORT/ADAPT of OpenJarvis (Stanford, Apache-2.0)
//   Upstream: https://github.com/open-jarvis/OpenJarvis  (see THIRD_PARTY_NOTICES.md)
//   Source file: src/openjarvis/security/capabilities.py
//   Commit: 5e5f5efde4bfcf8a60fe70d1cea12a0185f615ec
//   License text: licenses/OPENJARVIS-LICENSE-APACHE-2.0.txt
//
// Preserved upstream semantics:
//   - the Capability label set, verbatim ("file:read" … "system:admin"), plus
//     the CHIEF-only extensions "finance:read" (Phase 7), "skill:read"
//     (Phase 8), "web:search" (governed public web search), and
//     "module:access" (the per-user Module 02 read switch). Financial
//     reads must not reuse memory:read. Loading a procedure must not reuse
//     memory:read either. Public web search must not reuse network:fetch:
//     that label is general outbound network access, and it stays off the
//     default baseline. module:access lets the user inspect or request the
//     Module 02 read switch. It does not grant the financial data itself.
//     OpenJarvis has none of these four labels.
//   - CapabilityPolicy check order: explicit denials always win; grants are
//     glob-matched on capability and optionally on resource; agents with no
//     explicit policy fall back to `_default` wildcard grants; an anonymous
//     (empty) agent id never inherits `_default`; an explicit empty policy is
//     still identity-specific and does not inherit the wildcard's grants;
//     open-by-default unless defaultDeny
//   - policy documents: validate the complete document before applying any
//     grants (a malformed file must not silently discard configured denies);
//     save/load round trip with { agents: [{ agent_id, grants, deny }] }
//   - canonicalToolCapabilities fail-closed floor: an inventoried tool uses
//     its inventory entry; an uninventoried in-tree tool fails closed as
//     system:admin; remote-named (MCP) tools resolve to tool:invoke so a
//     server cannot impersonate a reviewed-safe local tool
// Documented adaptations (CHIEF-specific reasons):
//   - Upstream delegates check() to a Rust module whose behavior matches the
//     retained Python reference `_check_python`; CHIEF implements that
//     documented behavior once, in JS.
//   - Python fnmatch globs are reimplemented for `*`, `?` and `[...]` classes.
//   - loadPolicyDocument/savePolicyDocument operate on parsed objects instead
//     of file paths: in this deployment policies live in Postgres
//     (chief_capability_grant), not on disk. Validation rules are unchanged.
//   - DEFAULT_TOOL_CAPABILITIES stays empty. The live CHIEF inventory is
//     passed in by ToolExecutor (server/chief/tools/inventory.js). An omitted
//     inventory still fails closed as system:admin. OpenJarvis's own tool
//     list is not copied.

export const Capability = Object.freeze({
  FILE_READ: "file:read",
  FILE_WRITE: "file:write",
  NETWORK_FETCH: "network:fetch",
  CODE_EXECUTE: "code:execute",
  MEMORY_READ: "memory:read",
  MEMORY_WRITE: "memory:write",
  CHANNEL_SEND: "channel:send",
  TOOL_INVOKE: "tool:invoke",
  SCHEDULE_CREATE: "schedule:create",
  SYSTEM_ADMIN: "system:admin",
  // CHIEF extension. Not an OpenJarvis label. Financial tools require this
  // instead of memory:read.
  FINANCE_READ: "finance:read",
  // CHIEF extension. Not an OpenJarvis label. skill_view reads a bundled
  // procedure. It does not grant the capabilities that procedure names.
  SKILL_READ: "skill:read",
  // CHIEF extension. Not an OpenJarvis label. web_search reads the public
  // web through one fixed search provider. It is not network:fetch and it
  // does not authorize arbitrary HTTP, browsing, or mutation.
  WEB_SEARCH: "web:search",
  // CHIEF extension. Not an OpenJarvis label. Lets the authenticated user
  // inspect or request the Module 02 read switch. It does not reveal
  // financial data and it cannot grant a write.
  MODULE_ACCESS: "module:access",
  // CHIEF extensions. Not OpenJarvis labels. Each gates one conversation
  // tool group. The per-user flags are the real authorization and default
  // off. Read does not imply organize, and organize does not imply delete.
  CONVERSATION_READ: "conversation:read",
  CONVERSATION_ORGANIZE: "conversation:organize",
  CONVERSATION_DELETE: "conversation:delete",
});

const CAPABILITY_VALUES = new Set(Object.values(Capability));

export function isCapability(value) {
  return CAPABILITY_VALUES.has(value);
}

// Python fnmatch.fnmatch equivalent for the glob subset the policy uses:
// `*` (any run), `?` (any single char), `[seq]` / `[!seq]` classes.
export function fnmatch(name, pattern) {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else if (char === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) {
        regex += "\\[";
      } else {
        let body = pattern.slice(i + 1, close);
        if (body.startsWith("!")) body = "^" + body.slice(1);
        regex += `[${body.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else {
      regex += char.replace(/[.+^${}()|\\/]/g, "\\$&");
    }
    i += 1;
  }
  return new RegExp(`^${regex}$`).test(name);
}

const DEFAULT_AGENT = "_default";

export class CapabilityPolicy {
  constructor({ defaultDeny = false, policyDocument = null } = {}) {
    this._policies = new Map();
    this._defaultDeny = defaultDeny;
    if (policyDocument !== null) {
      this.loadPolicyDocument(policyDocument);
    }
  }

  _policyFor(agentId) {
    if (!this._policies.has(agentId)) {
      this._policies.set(agentId, { agentId, grants: [], deny: [] });
    }
    return this._policies.get(agentId);
  }

  grant(agentId, capability, pattern = "*") {
    this._policyFor(agentId).grants.push({ capability, pattern });
  }

  deny(agentId, capability) {
    this._policyFor(agentId).deny.push(capability);
  }

  check(agentId, capability, resource = "") {
    // Fall back to the `_default` wildcard agent's grants only when agentId
    // has no explicit policy of its own; an agent-specific denial always
    // wins, and an anonymous executor never inherits the wildcard.
    if (!agentId || agentId === DEFAULT_AGENT || this._policies.has(agentId)) {
      return this._checkAgent(agentId, capability, resource);
    }
    if (this._policies.has(DEFAULT_AGENT)) {
      return this._checkAgent(DEFAULT_AGENT, capability, resource);
    }
    return this._checkAgent(agentId, capability, resource);
  }

  _checkAgent(agentId, capability, resource) {
    const policy = agentId ? this._policies.get(agentId) : undefined;
    if (!policy) {
      // No explicit policy — use default. An empty agent id has no policy by
      // construction and therefore resolves here.
      return !this._defaultDeny;
    }
    for (const denied of policy.deny) {
      if (fnmatch(capability, denied)) return false;
    }
    for (const grant of policy.grants) {
      if (fnmatch(capability, grant.capability)) {
        if (resource && grant.pattern !== "*") {
          if (fnmatch(resource, grant.pattern)) return true;
        } else {
          return true;
        }
      }
    }
    return !this._defaultDeny;
  }

  listGrants(agentId) {
    const policy = this._policies.get(agentId);
    return policy ? [...policy.grants] : [];
  }

  listAgents() {
    return [...this._policies.keys()];
  }

  loadPolicyDocument(data) {
    // Upstream rule: validate the complete document before applying any
    // grants, so a malformed policy cannot silently discard configured denies.
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      !Array.isArray(data.agents)
    ) {
      throw new Error("Capability policy must contain an agents list");
    }
    for (const agentData of data.agents) {
      if (typeof agentData !== "object" || agentData === null || Array.isArray(agentData)) {
        throw new Error("Capability policy agent must be an object");
      }
      const agentId = agentData.agent_id;
      if (typeof agentId !== "string" || agentId.trim() === "") {
        throw new Error("Capability policy agent_id must be a nonempty string");
      }
      const grants = agentData.grants ?? [];
      const denied = agentData.deny ?? [];
      if (!Array.isArray(grants) || !Array.isArray(denied)) {
        throw new Error("Capability policy grants and deny must be lists");
      }
      for (const grant of grants) {
        if (
          typeof grant !== "object" ||
          grant === null ||
          typeof grant.capability !== "string" ||
          grant.capability.trim() === "" ||
          typeof (grant.pattern ?? "*") !== "string"
        ) {
          throw new Error("Capability policy grant must specify a capability");
        }
      }
      if (denied.some((cap) => typeof cap !== "string" || cap.trim() === "")) {
        throw new Error("Capability policy deny entries must be strings");
      }
    }

    for (const agentData of data.agents) {
      const agentId = agentData.agent_id;
      // An explicit empty policy is still an identity-specific policy; it
      // must not accidentally inherit the wildcard's grants.
      this._policyFor(agentId);
      for (const grant of agentData.grants ?? []) {
        this.grant(agentId, grant.capability, grant.pattern ?? "*");
      }
      for (const denied of agentData.deny ?? []) {
        this.deny(agentId, denied);
      }
    }
  }

  savePolicyDocument() {
    return {
      agents: [...this._policies.values()].map((policy) => ({
        agent_id: policy.agentId,
        grants: policy.grants.map((g) => ({
          capability: g.capability,
          pattern: g.pattern,
        })),
        deny: [...policy.deny],
      })),
    };
  }
}

// Canonical capability requirements for every in-tree CHIEF tool. This table
// is a security floor: tool specs may add requirements but may not weaken
// these. Keep explicitly-safe tools present with an empty list so an omitted
// future built-in can be distinguished from a reviewed safe one. Populated as
// tools are registered in Phase 3.
export const DEFAULT_TOOL_CAPABILITIES = Object.freeze({});

export function canonicalToolCapabilities(
  toolName,
  { remote = false, inventory = DEFAULT_TOOL_CAPABILITIES } = {}
) {
  if (remote) {
    // Remote (e.g. MCP) tool names are remote-controlled: resolve provenance
    // before the name table so a server cannot impersonate a reviewed-safe
    // local tool.
    return [Capability.TOOL_INVOKE];
  }
  const floor = inventory ?? DEFAULT_TOOL_CAPABILITIES;
  if (Object.prototype.hasOwnProperty.call(floor, toolName)) {
    return [...floor[toolName]];
  }
  // An in-tree tool registered without being inventoried fails closed as
  // system:admin instead of silently becoming unrestricted.
  return [Capability.SYSTEM_ADMIN];
}

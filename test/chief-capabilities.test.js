// CHIEF capability policy tests — translated from OpenJarvis
// tests/security/test_capabilities.py (commit 5e5f5ef). File-based load/save
// becomes policy-document load/save (documented adaptation); the ToolExecutor
// integration tests belong to Phase 3 when the executor gate pipeline lands.

import test from "node:test";
import assert from "node:assert/strict";

import {
  Capability,
  CapabilityPolicy,
  DEFAULT_TOOL_CAPABILITIES,
  canonicalToolCapabilities,
  fnmatch,
  isCapability,
} from "../server/chief/core/capabilities.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";

test("capability wire values match upstream, plus the CHIEF-only labels", () => {
  assert.equal(Capability.FILE_READ, "file:read");
  assert.equal(Capability.NETWORK_FETCH, "network:fetch");
  assert.equal(Capability.CODE_EXECUTE, "code:execute");
  assert.equal(Capability.SYSTEM_ADMIN, "system:admin");
  assert.equal(Capability.FINANCE_READ, "finance:read");
  assert.equal(Capability.SKILL_READ, "skill:read");
  assert.equal(Capability.WEB_SEARCH, "web:search");
  assert.equal(Capability.MODULE_ACCESS, "module:access");
  assert.equal(Capability.CONVERSATION_READ, "conversation:read");
  const upstream = new Set([
    "file:read",
    "file:write",
    "network:fetch",
    "code:execute",
    "memory:read",
    "memory:write",
    "channel:send",
    "tool:invoke",
    "schedule:create",
    "system:admin",
  ]);
  const values = new Set(Object.values(Capability));
  for (const label of upstream) assert.equal(values.has(label), true);
  assert.equal(values.has("finance:read"), true);
  assert.equal(values.has("skill:read"), true);
  assert.equal(values.has("web:search"), true);
  assert.equal(values.has("module:access"), true);
  assert.equal(values.has("conversation:read"), true);
  assert.equal(values.size, upstream.size + 5);
  assert.equal(isCapability("file:read"), true);
  assert.equal(isCapability("finance:read"), true);
  assert.equal(isCapability("skill:read"), true);
  assert.equal(isCapability("web:search"), true);
  assert.equal(isCapability("module:access"), true);
  assert.equal(isCapability("conversation:read"), true);
  assert.equal(isCapability("file:destroy"), false);
});

test("open by default; deny-by-default flips it", () => {
  const open = new CapabilityPolicy();
  assert.equal(open.check("agent1", "file:read"), true);
  assert.equal(open.check("agent1", "code:execute"), true);

  const closed = new CapabilityPolicy({ defaultDeny: true });
  assert.equal(closed.check("agent1", "file:read"), false);
});

test("explicit grant under default deny", () => {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("agent1", "file:read");
  assert.equal(policy.check("agent1", "file:read"), true);
  assert.equal(policy.check("agent1", "code:execute"), false);
});

test("explicit deny wins over the open default and over grants", () => {
  const policy = new CapabilityPolicy();
  policy.deny("agent1", "code:execute");
  assert.equal(policy.check("agent1", "code:execute"), false);
  assert.equal(policy.check("agent1", "file:read"), true);

  const granted = new CapabilityPolicy();
  granted.grant("agent1", "code:execute");
  granted.deny("agent1", "code:execute");
  assert.equal(granted.check("agent1", "code:execute"), false);
});

test("agent-specific deny overrides a _default wildcard grant", () => {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("_default", "code:execute");
  policy.deny("agent1", "code:execute");
  assert.equal(policy.check("agent1", "code:execute"), false);
});

test("unconfigured agent inherits _default grants", () => {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("_default", "file:read");
  assert.equal(policy.check("unconfigured-agent", "file:read"), true);
  assert.equal(policy.check("unconfigured-agent", "file:write"), false);
});

test("anonymous executor cannot inherit _default grants", () => {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("_default", "code:execute");
  assert.equal(policy.check("", "code:execute"), false);
});

test("resource patterns restrict grants", () => {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("agent1", "file:read", "/safe/*");
  assert.equal(policy.check("agent1", "file:read", "/safe/data.txt"), true);
  assert.equal(policy.check("agent1", "file:read", "/etc/passwd"), false);
});

test("glob patterns match capability families", () => {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("agent1", "file:*");
  assert.equal(policy.check("agent1", "file:read"), true);
  assert.equal(policy.check("agent1", "file:write"), true);
  assert.equal(policy.check("agent1", "code:execute"), false);
});

test("listGrants and listAgents", () => {
  const policy = new CapabilityPolicy();
  policy.grant("agent1", "file:read");
  policy.grant("agent1", "code:execute");
  policy.grant("agent2", "code:execute");
  assert.equal(policy.listGrants("agent1").length, 2);
  assert.deepEqual(new Set(policy.listAgents()), new Set(["agent1", "agent2"]));
  assert.deepEqual(policy.listGrants("unknown"), []);
});

test("policy document round trip preserves grants and denies", () => {
  const policy = new CapabilityPolicy();
  policy.grant("agent1", "file:read");
  policy.deny("agent1", "code:execute");
  const document = policy.savePolicyDocument();

  const loaded = new CapabilityPolicy({ policyDocument: document });
  assert.equal(loaded.check("agent1", "file:read"), true);
  assert.equal(loaded.check("agent1", "code:execute"), false);
});

test("an explicit empty policy does not inherit _default grants", () => {
  const policy = new CapabilityPolicy({
    defaultDeny: true,
    policyDocument: {
      agents: [
        { agent_id: "_default", grants: [{ capability: "code:execute" }] },
        { agent_id: "restricted", grants: [] },
      ],
    },
  });
  assert.equal(policy.check("unconfigured", "code:execute"), true);
  assert.equal(policy.check("restricted", "code:execute"), false);
});

test("invalid policy documents are rejected before any grant applies", () => {
  const invalidDocuments = [
    [],
    {},
    { agents: {} },
    { agents: [{}] },
    { agents: [{ agent_id: "a", deny: "code:execute" }] },
    { agents: [{ agent_id: "a", grants: [{ pattern: "*" }] }] },
    { agents: [{ agent_id: "" }] },
  ];
  for (const document of invalidDocuments) {
    assert.throws(
      () => new CapabilityPolicy({ policyDocument: document }),
      Error,
      `expected rejection for ${JSON.stringify(document)}`
    );
  }
});

test("uninventoried in-tree tool fails closed as system:admin", () => {
  assert.deepEqual(canonicalToolCapabilities("future_builtin"), [Capability.SYSTEM_ADMIN]);
});

test("remote tool names resolve to tool:invoke, never a reviewed-safe floor", () => {
  // A remote (MCP) server must not impersonate a reviewed-safe local tool.
  assert.deepEqual(canonicalToolCapabilities("calculator", { remote: true }), [
    Capability.TOOL_INVOKE,
  ]);
});

test("inventory is the security floor for inventoried tools", () => {
  // The default table stays empty. Phase 4 passes CHIEF_TOOL_INVENTORY into
  // the executor so a reviewed tool does not pick up the system:admin floor.
  assert.deepEqual(DEFAULT_TOOL_CAPABILITIES, {});
  assert.ok(Object.isFrozen(DEFAULT_TOOL_CAPABILITIES));
  assert.deepEqual(canonicalToolCapabilities("memory_read", { inventory: CHIEF_TOOL_INVENTORY }), [
    Capability.MEMORY_READ,
  ]);
  assert.deepEqual(
    canonicalToolCapabilities("finance_summary", { inventory: CHIEF_TOOL_INVENTORY }),
    [Capability.FINANCE_READ]
  );
  assert.deepEqual(
    canonicalToolCapabilities("workspace_plan_summary", { inventory: CHIEF_TOOL_INVENTORY }),
    [Capability.FINANCE_READ]
  );
  assert.deepEqual(canonicalToolCapabilities("skill_view", { inventory: CHIEF_TOOL_INVENTORY }), [
    Capability.SKILL_READ,
  ]);
  assert.deepEqual(
    canonicalToolCapabilities("module02_access_status", { inventory: CHIEF_TOOL_INVENTORY }),
    [Capability.MODULE_ACCESS]
  );
  assert.deepEqual(
    canonicalToolCapabilities("module02_access_set", { inventory: CHIEF_TOOL_INVENTORY }),
    [Capability.MODULE_ACCESS]
  );
  assert.deepEqual(canonicalToolCapabilities("web_search", { inventory: CHIEF_TOOL_INVENTORY }), [
    Capability.WEB_SEARCH,
  ]);
  assert.deepEqual(
    canonicalToolCapabilities("conversation_search", { inventory: CHIEF_TOOL_INVENTORY }),
    [Capability.CONVERSATION_READ]
  );
  assert.deepEqual(
    canonicalToolCapabilities("conversation_retrieve", { inventory: CHIEF_TOOL_INVENTORY }),
    [Capability.CONVERSATION_READ]
  );
  assert.deepEqual(canonicalToolCapabilities("memory_read"), [Capability.SYSTEM_ADMIN]);
  assert.deepEqual(canonicalToolCapabilities("getUserData"), [Capability.SYSTEM_ADMIN]);
  assert.equal(Object.hasOwn(CHIEF_TOOL_INVENTORY, "shell_exec"), false);
  assert.equal(Object.hasOwn(CHIEF_TOOL_INVENTORY, "code_interpreter"), false);
});

test("fnmatch matches Python fnmatch semantics for the policy's glob subset", () => {
  assert.equal(fnmatch("file:read", "file:*"), true);
  assert.equal(fnmatch("file:read", "*"), true);
  assert.equal(fnmatch("code:execute", "file:*"), false);
  assert.equal(fnmatch("/safe/data.txt", "/safe/*"), true);
  assert.equal(fnmatch("/etc/passwd", "/safe/*"), false);
  assert.equal(fnmatch("a.txt", "?.txt"), true);
  assert.equal(fnmatch("ab.txt", "?.txt"), false);
  assert.equal(fnmatch("file1", "file[0-9]"), true);
  assert.equal(fnmatch("fileX", "file[0-9]"), false);
  assert.equal(fnmatch("fileX", "file[!0-9]"), true);
});

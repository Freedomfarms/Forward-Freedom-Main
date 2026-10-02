// Phase 16 — zero grant rows install a _default baseline.
// web:search is included with the governed web search tool.
// policyFromGrantRows stays a pure mapping. A thrown load stays deny-all.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { Capability } from "../server/chief/core/capabilities.js";
import { MemoryFactStore } from "../server/chief/memory/facts.js";
import { quietAttention } from "../server/chief/scheduler/operative.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import {
  closedPolicy,
  loadCapabilityPolicy,
  policyFromGrantRows,
} from "../server/chief/security/grants.js";
import { createChiefTooling, createChiefTools } from "../server/chief/tools/builtin.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { MemoryScheduleStore } from "../server/chief/tools/schedule-store.js";

const ALLOWED = [
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
];

const DENIED = [
  Capability.FILE_READ,
  Capability.FILE_WRITE,
  Capability.NETWORK_FETCH,
  Capability.CODE_EXECUTE,
  Capability.CHANNEL_SEND,
  Capability.TOOL_INVOKE,
  Capability.SYSTEM_ADMIN,
];

function emptyLoader() {
  const calls = [];
  return {
    calls,
    withUser: async (_userId, fn) =>
      fn({
        chiefCapabilityGrant: {
          findMany: async () => {
            calls.push("findMany");
            return [];
          },
          create: async () => calls.push("create"),
          createMany: async () => calls.push("createMany"),
          update: async () => calls.push("update"),
          updateMany: async () => calls.push("updateMany"),
          upsert: async () => calls.push("upsert"),
          delete: async () => calls.push("delete"),
          deleteMany: async () => calls.push("deleteMany"),
        },
      }),
  };
}

test("zero grant rows allow the baseline capabilities for chief", async () => {
  const { withUser } = emptyLoader();
  const policy = await loadCapabilityPolicy("user", { withUser });
  assert.equal(policy._defaultDeny, true);
  assert.deepEqual(
    policy.listGrants("_default").map((grant) => grant.capability),
    ALLOWED
  );
  for (const capability of ALLOWED) {
    assert.equal(policy.check("chief", capability), true, capability);
  }
});

test("the baseline denies dangerous capabilities", async () => {
  const policy = await loadCapabilityPolicy("user", { withUser: emptyLoader().withUser });
  assert.equal(policy._defaultDeny, true);
  for (const capability of DENIED) {
    assert.equal(policy.check("chief", capability), false, capability);
    assert.equal(
      policy.listGrants("_default").some((grant) => grant.capability === capability),
      false,
      capability
    );
  }
});

test("an anonymous agent does not inherit the baseline", async () => {
  const policy = await loadCapabilityPolicy("user", { withUser: emptyLoader().withUser });
  for (const capability of ALLOWED) {
    assert.equal(policy.check("", capability), false, capability);
  }
});

test("one explicit grant for another agent replaces the baseline", async () => {
  const policy = await loadCapabilityPolicy("user", {
    withUser: async (_userId, fn) =>
      fn({
        chiefCapabilityGrant: {
          findMany: async () => [{ agentId: "other", capability: "memory:read", deny: false }],
        },
      }),
  });
  assert.equal(policy.listAgents().includes("_default"), false);
  assert.equal(policy.check("other", "memory:read"), true);
  assert.equal(policy.check("other", "memory:write"), false);
  assert.equal(policy.check("other", "schedule:create"), false);
  assert.equal(policy.check("chief", "memory:read"), false);
  assert.equal(policy.check("chief", "finance:read"), false);
  assert.equal(policy.check("chief", "skill:read"), false);
  assert.equal(policy.check("chief", "web:search"), false);
  assert.equal(policy.check("chief", "module:access"), false);
  assert.equal(policy.check("chief", "conversation:read"), false);
});

test("one explicit chief grant does not receive the remaining baseline", async () => {
  const policy = await loadCapabilityPolicy("user", {
    withUser: async (_userId, fn) =>
      fn({
        chiefCapabilityGrant: {
          findMany: async () => [{ agentId: "chief", capability: "memory:read", pattern: "*" }],
        },
      }),
  });
  assert.equal(policy.listAgents().includes("_default"), false);
  assert.equal(policy.check("chief", "memory:read"), true);
  assert.equal(policy.check("chief", "memory:write"), false);
  assert.equal(policy.check("chief", "schedule:create"), false);
  assert.equal(policy.check("chief", "finance:read"), false);
  assert.equal(policy.check("chief", "skill:read"), false);
  assert.equal(policy.check("chief", "web:search"), false);
  assert.equal(policy.check("chief", "module:access"), false);
  assert.equal(policy.check("chief", "conversation:read"), false);
  assert.equal(policy._defaultDeny, true);
});

test("policyFromGrantRows([]) stays closed and has no _default grants", () => {
  const policy = policyFromGrantRows([]);
  assert.equal(policy._defaultDeny, true);
  assert.deepEqual(policy.listAgents(), []);
  assert.deepEqual(policy.listGrants("_default"), []);
  for (const capability of ALLOWED) {
    assert.equal(policy.check("chief", capability), false, capability);
  }
});

test("a thrown load stays deny-all", async () => {
  await assert.rejects(
    () =>
      loadCapabilityPolicy("user", {
        withUser: async () => {
          throw new Error("db down");
        },
      }),
    /db down/
  );
  const tooling = await createChiefTooling({
    userId: "",
    stores: { facts: new MemoryFactStore(), schedule: new MemoryScheduleStore() },
    audit: new MemoryAuditLog(),
  });
  assert.equal(tooling.policy._defaultDeny, true);
  assert.equal(tooling.policy.listAgents().includes("_default"), false);
  for (const capability of ALLOWED) {
    assert.equal(tooling.policy.check("chief", capability), false, capability);
  }
  const closed = closedPolicy();
  assert.equal(closed.check("chief", "memory:read"), false);
  assert.equal(closed._defaultDeny, true);
});

test("memory_read runs and schedule_create stops at confirmation", async () => {
  const policy = await loadCapabilityPolicy("user", { withUser: emptyLoader().withUser });
  const schedule = new MemoryScheduleStore();
  const audit = new MemoryAuditLog();
  const executor = new ToolExecutor({
    tools: createChiefTools({ facts: new MemoryFactStore(), schedule }),
    policy,
    audit,
  });
  const read = await executor.execute(
    { callId: "read", name: "memory_read", arguments: { query: "" } },
    { userId: "user", agentId: "chief" }
  );
  assert.equal(read.isError, false);
  assert.match(read.output, /"facts":\[\]/);

  const created = await executor.execute(
    {
      callId: "create",
      name: "schedule_create",
      arguments: { name: "digest", kind: "once", prompt: "summarize" },
    },
    { userId: "user", agentId: "chief" }
  );
  assert.equal(created.isError, true);
  assert.match(created.output, /requires confirmation/);
  assert.equal(
    audit.entries.some((entry) => entry.action === "tool.confirmation_required"),
    true
  );
  assert.deepEqual(await schedule.list({ userId: "user" }), []);
});

test("mcp_invoke stays boundary blocked under the baseline", async () => {
  const policy = await loadCapabilityPolicy("user", { withUser: emptyLoader().withUser });
  const audit = new MemoryAuditLog();
  const executor = new ToolExecutor({
    tools: createChiefTools({ facts: new MemoryFactStore() }),
    policy,
    audit,
  });
  const blocked = await executor.execute(
    { callId: "mcp", name: "mcp_invoke", arguments: { server: "s", tool: "t" } },
    { userId: "user", agentId: "chief", mutationApproved: true }
  );
  assert.equal(blocked.isError, true);
  assert.match(blocked.output, /boundary guard blocked non-local tool 'mcp_invoke'/);
  assert.equal(
    audit.entries.some((entry) => entry.action === "tool.boundary_blocked"),
    true
  );
});

test("quietAttention stays false and takes no arguments", () => {
  const quiet = readFileSync(
    new URL("../server/chief/scheduler/operative.js", import.meta.url),
    "utf8"
  );
  assert.match(quiet, /export function quietAttention\(\) \{\s*return false;\s*\}/);
  assert.equal(quietAttention.length, 0);
  assert.equal(quietAttention(), false);
  assert.equal(quietAttention({ attention: true }), false);
});

test("the empty-row loader only reads grant rows", async () => {
  const { calls, withUser } = emptyLoader();
  const policy = await loadCapabilityPolicy("user", { withUser });
  assert.deepEqual(calls, ["findMany"]);
  assert.equal(policy.check("chief", "memory:read"), true);
});

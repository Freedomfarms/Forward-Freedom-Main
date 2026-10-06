// Phase 16 — zero grant rows install a _default baseline.
// Stored rows merge onto that baseline. An explicit deny still removes
// the named capability. policyFromGrantRows stays a pure mapping.
// A thrown load stays deny-all.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { discoverCapabilities } from "../server/chief/capabilities/discover.js";
import { createCodeIntel } from "../server/chief/codeintel/index.js";
import { defineConnector } from "../server/chief/connectors/registry.js";
import { baselineCapabilities } from "../server/chief/control/plane.js";
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
import { BaseTool } from "../server/chief/tools/spec.js";

const ALLOWED = Object.freeze(baselineCapabilities());

const DENIED = [
  Capability.FILE_READ,
  Capability.FILE_WRITE,
  Capability.NETWORK_FETCH,
  Capability.CODE_EXECUTE,
  Capability.CHANNEL_SEND,
  Capability.EMAIL_READ,
  Capability.EMAIL_SEND,
  Capability.CALENDAR_READ,
  Capability.CALENDAR_WRITE,
  Capability.DRIVE_READ,
  Capability.GITHUB_READ,
  Capability.GITHUB_WRITE,
  Capability.DATA_READ,
  Capability.DATA_WRITE,
  Capability.TOOL_INVOKE,
  Capability.SYSTEM_ADMIN,
];

function grantLoader(rows, calls = null) {
  return async (_userId, fn) =>
    fn({
      chiefCapabilityGrant: {
        findMany: async () => {
          calls?.push("findMany");
          return rows;
        },
        create: async () => calls?.push("create"),
        createMany: async () => calls?.push("createMany"),
        update: async () => calls?.push("update"),
        updateMany: async () => calls?.push("updateMany"),
        upsert: async () => calls?.push("upsert"),
        delete: async () => calls?.push("delete"),
        deleteMany: async () => calls?.push("deleteMany"),
      },
    });
}

function emptyLoader() {
  const calls = [];
  return { calls, withUser: grantLoader([], calls) };
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

test("one explicit grant for another agent keeps the baseline", async () => {
  const policy = await loadCapabilityPolicy("user", {
    withUser: grantLoader([{ agentId: "other", capability: "memory:read", deny: false }]),
  });
  assert.equal(policy.listAgents().includes("_default"), true);
  assert.equal(policy._defaultDeny, true);
  for (const capability of ALLOWED) {
    assert.equal(policy.check("other", capability), true, capability);
    assert.equal(policy.check("chief", capability), true, capability);
    assert.equal(policy.check("", capability), false, capability);
  }
  for (const capability of DENIED) {
    assert.equal(policy.check("other", capability), false, capability);
    assert.equal(policy.check("chief", capability), false, capability);
  }
});

test("one explicit chief grant keeps the remaining baseline", async () => {
  const policy = await loadCapabilityPolicy("user", {
    withUser: grantLoader([{ agentId: "chief", capability: "memory:read", pattern: "*" }]),
  });
  assert.equal(policy.listAgents().includes("_default"), true);
  assert.equal(policy._defaultDeny, true);
  for (const capability of ALLOWED) {
    assert.equal(policy.check("chief", capability), true, capability);
  }
  assert.equal(policy.check("chief", Capability.CODE_READ), true);
  assert.equal(policy.check("chief", Capability.CAPABILITY_READ), true);
  for (const capability of DENIED) {
    assert.equal(policy.check("chief", capability), false, capability);
  }
});

test("a stored grant still leaves every baseline read, including code:read and capability:read", async () => {
  const policy = await loadCapabilityPolicy("user", {
    withUser: grantLoader([{ agentId: "chief", capability: "finance:read", pattern: "reports/*" }]),
  });
  const reads = [
    Capability.MEMORY_READ,
    Capability.SCHEDULE_READ,
    Capability.FINANCE_READ,
    Capability.SKILL_READ,
    Capability.WEB_SEARCH,
    Capability.MODULE_ACCESS,
    Capability.CONVERSATION_READ,
    Capability.SETTINGS_READ,
    Capability.CAPABILITY_READ,
    Capability.CODE_READ,
  ];
  for (const capability of reads) {
    assert.equal(policy.check("chief", capability), true, capability);
  }
  assert.equal(policy.check("chief", Capability.CODE_READ), true);
  assert.equal(policy.check("chief", Capability.CAPABILITY_READ), true);
});

test("an explicit deny still removes a baseline capability", async () => {
  const policy = await loadCapabilityPolicy("user", {
    withUser: grantLoader([
      { agentId: "chief", capability: "memory:read", deny: false },
      { agentId: "chief", capability: "code:read", deny: true },
      { agentId: "_default", capability: "capability:read", deny: true },
    ]),
  });
  assert.equal(policy.check("chief", Capability.CODE_READ), false);
  assert.equal(policy.check("chief", Capability.CAPABILITY_READ), false);
  assert.equal(policy.check("chief", Capability.MEMORY_READ), true);
  assert.equal(policy.check("chief", Capability.WEB_SEARCH), true);
  assert.equal(policy.check("chief", Capability.FILE_READ), false);
  assert.equal(policy.check("chief", Capability.CODE_EXECUTE), false);
});

test("a stored memory:write deny removes that write and leaves baseline reads", async () => {
  const policy = await loadCapabilityPolicy("user", {
    withUser: grantLoader([
      { agentId: "chief", capability: "schedule:read", deny: false },
      { agentId: "chief", capability: "memory:write", deny: true },
    ]),
  });
  assert.equal(policy.check("chief", Capability.MEMORY_WRITE), false);
  assert.equal(policy.check("chief", Capability.CODE_READ), true);
  assert.equal(policy.check("chief", Capability.CAPABILITY_READ), true);
  assert.equal(policy.check("chief", Capability.FILE_WRITE), false);
  assert.equal(policy.check("chief", Capability.CODE_EXECUTE), false);
  assert.equal(policy.check("chief", Capability.EMAIL_SEND), false);
  assert.equal(policy.check("chief", Capability.DATA_WRITE), false);
  const facts = new MemoryFactStore();
  const executor = new ToolExecutor({
    tools: createChiefTools({ facts }),
    policy,
    audit: new MemoryAuditLog(),
  });
  const write = await executor.execute(
    { callId: "w", name: "memory_write", arguments: { content: "keep this out" } },
    { userId: "user", agentId: "chief", mutationApproved: true }
  );
  assert.equal(write.isError, true);
  assert.match(write.output, /memory:write/);
});

test("approval-required actions still require approval under a merged grant", async () => {
  const policy = await loadCapabilityPolicy("user", {
    withUser: grantLoader([{ agentId: "chief", capability: "memory:read", deny: false }]),
  });
  const schedule = new MemoryScheduleStore();
  const facts = new MemoryFactStore();
  const audit = new MemoryAuditLog();
  const executor = new ToolExecutor({
    tools: createChiefTools({ facts, schedule }),
    policy,
    audit,
  });
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
  assert.deepEqual(await schedule.list({ userId: "user" }), []);
  const write = await executor.execute(
    { callId: "w", name: "memory_write", arguments: { content: "not yet" } },
    { userId: "user", agentId: "chief", mutationApproved: false }
  );
  assert.equal(write.isError, true);
  assert.match(write.output, /requires confirmation/);
  assert.equal(
    audit.entries.some((entry) => entry.action === "tool.confirmation_required"),
    true
  );
});

test("a merged grant still refuses protected code paths before fetch", async () => {
  const policy = await loadCapabilityPolicy("user", {
    withUser: grantLoader([{ agentId: "chief", capability: "memory:read", deny: false }]),
  });
  assert.equal(policy.check("chief", Capability.CODE_READ), true);
  const calls = [];
  const token = `ghp_${"b".repeat(36)}`;
  const codeintel = createCodeIntel({
    env: {
      CHIEF_CODE_READ_TOKEN: token,
      CHIEF_CODE_REPOSITORY: "Freedomfarms/Forward-Freedom-Main",
      CHIEF_CODE_DEFAULT_REF: "main",
    },
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error("fetch should not run");
    },
  });
  const tooling = await createChiefTooling({
    userId: "user",
    policy,
    audit: new MemoryAuditLog(),
    stores: { facts: new MemoryFactStore(), schedule: new MemoryScheduleStore(), codeintel },
  });
  for (const path of [".env", ".env.local", "secrets/keys.pem", "credentials.json"]) {
    const refused = await tooling.executor.execute(
      { callId: path, name: "code_read", arguments: { path } },
      { userId: "user", agentId: "chief" }
    );
    assert.equal(refused.isError, true, path);
    assert.equal(JSON.parse(refused.output).error, "that path is not available");
    assert.equal(refused.output.includes(token), false);
  }
  assert.deepEqual(calls, []);
});

function emailConnector({ connected, sends = [] }) {
  return defineConnector({
    id: "email",
    label: "Email",
    connected,
    unavailableReason:
      "Email read access is unavailable because no email connector is currently connected.",
    capabilities: [
      {
        id: "email:read",
        effect: "read",
        grant: Capability.EMAIL_READ,
        confirmation: "none",
        tools: ["email_search"],
        reason:
          "Email read access is unavailable because no email connector is currently connected.",
      },
      {
        id: "email:send",
        effect: "external",
        grant: Capability.EMAIL_SEND,
        confirmation: "required",
        tools: ["email_send"],
        reason: "Email send is unavailable because no email connector is currently connected.",
      },
    ],
    createTools() {
      return [
        new BaseTool({
          isLocal: true,
          spec: {
            name: "email_send",
            description: "Send mail from the connected mailbox.",
            category: "email",
            effect: "external",
            confirmation: "required",
            audit: "full",
            requiresConfirmation: true,
            requiredCapabilities: [Capability.EMAIL_SEND],
            parameters: {
              type: "object",
              properties: { to: { type: "string" }, subject: { type: "string" } },
              required: ["to", "subject"],
            },
          },
          async execute(params) {
            sends.push(params);
            return { output: JSON.stringify({ id: "msg-1", sent: true }) };
          },
        }),
      ];
    },
  });
}

test("connector capabilities follow the connector and stay unavailable while disconnected", async () => {
  const stored = grantLoader([{ agentId: "chief", capability: "memory:read", deny: false }]);
  const disconnected = await loadCapabilityPolicy("user", { withUser: stored });
  assert.equal(disconnected.check("chief", Capability.EMAIL_READ), false);
  assert.equal(disconnected.check("chief", Capability.EMAIL_SEND), false);
  assert.equal(disconnected.check("chief", Capability.CALENDAR_READ), false);
  assert.equal(disconnected.check("chief", Capability.GITHUB_READ), false);
  assert.equal(disconnected.check("chief", Capability.CODE_READ), true);
  const snapshot = discoverCapabilities({ policy: disconnected, codeEnabled: true });
  const email = snapshot.capabilities.find((row) => row.id === "email:read");
  assert.equal(email.availability, "unavailable");
  assert.equal(email.tools.length, 0);
  assert.equal(
    email.reason,
    "Email read access is unavailable because no email connector is currently connected."
  );
  const offline = await createChiefTooling({
    userId: "user",
    policy: disconnected,
    audit: new MemoryAuditLog(),
    connectors: [emailConnector({ connected: false })],
    stores: { facts: new MemoryFactStore(), schedule: new MemoryScheduleStore() },
  });
  assert.equal(
    offline.specs.some((spec) => spec.name === "email_search" || spec.name === "email_send"),
    false
  );
  const missing = await offline.executor.execute(
    { callId: "e", name: "email_search", arguments: { query: "inbox" } },
    { userId: "user", agentId: "chief" }
  );
  assert.equal(missing.isError, true);
  assert.match(missing.output, /Unknown tool/);

  const sends = [];
  const connectedConnector = emailConnector({ connected: true, sends });
  const connected = await loadCapabilityPolicy("user", {
    withUser: stored,
    connectors: [connectedConnector],
  });
  assert.equal(connected.check("chief", Capability.EMAIL_READ), true);
  assert.equal(connected.check("chief", Capability.EMAIL_SEND), true);
  assert.equal(connected.check("chief", Capability.CALENDAR_READ), false);
  assert.equal(connected.check("chief", Capability.FILE_WRITE), false);
  assert.equal(connected.check("chief", Capability.CODE_READ), true);
  const ready = discoverCapabilities({
    policy: connected,
    connectors: [connectedConnector],
    codeEnabled: true,
  });
  const readyEmail = ready.capabilities.find((row) => row.id === "email:read");
  assert.equal(readyEmail.availability, "ready");
  const gated = await createChiefTooling({
    userId: "user",
    policy: connected,
    audit: new MemoryAuditLog(),
    connectors: [connectedConnector],
    stores: { facts: new MemoryFactStore(), schedule: new MemoryScheduleStore() },
  });
  const unapproved = await gated.executor.execute(
    { callId: "s", name: "email_send", arguments: { to: "person@example.com", subject: "Hello" } },
    { userId: "user", agentId: "chief", mutationApproved: false }
  );
  assert.equal(unapproved.isError, true);
  assert.match(unapproved.output, /confirmation/);
  assert.equal(sends.length, 0);
});

test("policyFromGrantRows([]) stays closed and has no _default grants", () => {
  const policy = policyFromGrantRows([]);
  assert.equal(policy._defaultDeny, true);
  assert.deepEqual(policy.listAgents(), []);
  assert.deepEqual(policy.listGrants("_default"), []);
  for (const capability of ALLOWED) {
    assert.equal(policy.check("chief", capability), false, capability);
  }
  const pure = policyFromGrantRows([{ agentId: "chief", capability: "memory:read", deny: false }]);
  assert.equal(pure.listAgents().includes("_default"), false);
  assert.equal(pure.check("chief", Capability.MEMORY_READ), true);
  assert.equal(pure.check("chief", Capability.CODE_READ), false);
  assert.equal(pure.check("chief", Capability.CAPABILITY_READ), false);
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

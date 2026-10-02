// Unified control plane. Discovery comes from the registry, connector tools
// register without a TurnMachine edit, and Claude, GPT, and Grok see one surface.

import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverCapabilities,
  projectAccessInventory,
  renderCapabilityContext,
} from "../server/chief/capabilities/discover.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { defineConnector } from "../server/chief/connectors/registry.js";
import { ApprovalCoordinator } from "../server/chief/runtime/approvals.js";
import { classifyToolCalls, toolSpecsToAiTools } from "../server/chief/runtime/turn.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import { loadCapabilityPolicy } from "../server/chief/security/grants.js";
import { createChiefTooling, createChiefTools } from "../server/chief/tools/builtin.js";
import { BaseTool } from "../server/chief/tools/spec.js";
import {
  XAI_PROVIDER_ID,
  ANTHROPIC_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
} from "../server/chief/models/providers.js";

const ADDRESS = "person@example.com";

function emptyGrants() {
  return loadCapabilityPolicy("user-a", {
    withUser: async (_userId, fn) => fn({ chiefCapabilityGrant: { findMany: async () => [] } }),
  });
}

function policyWith(capabilities, denied = []) {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  for (const capability of capabilities) policy.grant("chief", capability);
  for (const capability of denied) policy.deny("chief", capability);
  return policy;
}

function emailConnector({ connected, messages = [], sends = [] }) {
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
            name: "email_search",
            description: "Search the connected mailbox.",
            category: "email",
            effect: "read",
            confirmation: "none",
            audit: "full",
            requiresConfirmation: false,
            requiredCapabilities: [Capability.EMAIL_READ],
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
          async execute() {
            return { output: JSON.stringify({ messages }) };
          },
        }),
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

test("discovery reports granted reads, approval, and disconnected connectors", async () => {
  const policy = await emptyGrants();
  const snapshot = discoverCapabilities({
    policy,
    module02Read: false,
    webCredentialPresent: true,
    codeEnabled: true,
  });
  const byId = Object.fromEntries(snapshot.capabilities.map((row) => [row.id, row]));
  assert.equal(byId["code:read"].availability, "ready");
  assert.deepEqual(byId["code:read"].tools, ["code_tree", "code_read", "code_search"]);
  assert.equal(byId["finance:read"].availability, "gated");
  assert.equal(byId["workspace:read"].grant, Capability.FINANCE_READ);
  assert.equal(byId["web:read"].availability, "ready");
  assert.equal(byId["web:read"].grant, Capability.WEB_SEARCH);
  assert.equal(byId["memory:write"].confirmation, "required");
  assert.equal(byId["settings:write"].confirmation, "required");
  assert.equal(byId["code:execute"].availability, "unavailable");
  assert.match(byId["email:read"].reason, /no email connector is currently connected/);
  assert.equal(byId["email:read"].tools.length, 0);
  assert.equal(byId["calendar:read"].availability, "unavailable");
  assert.equal(byId["drive:read"].availability, "unavailable");
  assert.match(byId["github:read"].reason, /code:read/);
  assert.equal(byId["file:read"].availability, "unavailable");
  assert.equal(byId["data:read"].availability, "unavailable");
  assert.equal(JSON.stringify(snapshot).includes(ADDRESS), false);

  const offline = discoverCapabilities({
    policy,
    webCredentialPresent: false,
    codeEnabled: false,
  });
  const offlineById = Object.fromEntries(offline.capabilities.map((row) => [row.id, row]));
  assert.equal(offlineById["code:read"].availability, "unavailable");
  assert.match(offlineById["code:read"].reason, /code intelligence is unavailable/);
  assert.equal(offlineById["web:read"].availability, "unavailable");

  const text = renderCapabilityContext(snapshot, { discoverExposed: true });
  assert.match(text, /capability_discover/);
  assert.match(text, /email:read:/);
  assert.doesNotMatch(text, /call web_search/);
  const inventory = projectAccessInventory(snapshot);
  assert.equal(inventory.connected.length, 0);
  assert.ok(inventory.read.some((row) => row.id === "code:read"));
  assert.ok(inventory.actions.some((row) => row.id === "memory:write" && row.approval === true));
  assert.ok(inventory.unavailable.some((row) => row.id === "email:read"));
});

test("capability_discover is the inventory and does not invent an email address", async () => {
  const tooling = await createChiefTooling({
    userId: "user-a",
    policy: await emptyGrants(),
    audit: new MemoryAuditLog(),
    connectors: [emailConnector({ connected: false })],
  });
  const result = await tooling.executor.execute(
    { callId: "d", name: "capability_discover", arguments: {} },
    { userId: "user-a", agentId: "chief", sessionId: "sess-1", model: "grok" }
  );
  assert.equal(result.isError, false);
  const body = JSON.parse(result.output);
  const email = body.capabilities.find((row) => row.id === "email:read");
  assert.match(email.reason, /no email connector is currently connected/);
  assert.equal(result.output.includes(ADDRESS), false);
  assert.equal(
    tooling.specs.some((spec) => spec.name === "email_search"),
    false
  );
  const denied = await tooling.executor.execute(
    { callId: "missing", name: "email_search", arguments: { query: ADDRESS } },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(denied.isError, true);
  assert.match(denied.output, /Unknown tool/);
});

test("a connected email connector is granted, audited, and still approval-gated", async () => {
  const messages = [{ id: "m1", subject: "Budget", from: ADDRESS }];
  const sends = [];
  const connectors = [emailConnector({ connected: true, messages, sends })];
  const audit = new MemoryAuditLog();
  const granted = await createChiefTooling({
    userId: "user-a",
    policy: policyWith([Capability.CAPABILITY_READ, Capability.EMAIL_READ, Capability.EMAIL_SEND]),
    audit,
    connectors,
  });
  const found = await granted.executor.execute(
    { callId: "r", name: "email_search", arguments: { query: "budget" } },
    { userId: "user-a", agentId: "chief", sessionId: "sess-9", model: "claude", turnId: "turn-9" }
  );
  assert.equal(found.isError, false);
  assert.match(found.output, /Budget/);
  assert.ok(
    audit.entries.some(
      (entry) =>
        entry.action === "capability.executed" &&
        entry.resource === "email_search" &&
        entry.capability === "email:read" &&
        entry.sessionId === "sess-9" &&
        entry.model === "claude" &&
        entry.approval === "not_required"
    )
  );

  const unapproved = await granted.executor.execute(
    { callId: "s", name: "email_send", arguments: { to: ADDRESS, subject: "Hello" } },
    { userId: "user-a", agentId: "chief", mutationApproved: false }
  );
  assert.equal(unapproved.isError, true);
  assert.match(unapproved.output, /confirmation/);
  assert.equal(sends.length, 0);

  const approved = await granted.executor.execute(
    { callId: "s2", name: "email_send", arguments: { to: ADDRESS, subject: "Hello" } },
    {
      userId: "user-a",
      agentId: "chief",
      mutationApproved: true,
      sessionId: "sess-9",
      model: "gpt",
    }
  );
  assert.equal(approved.isError, false);
  assert.equal(sends.length, 1);
  assert.match(approved.output, /msg-1/);
  assert.ok(
    audit.entries.some((entry) => entry.resource === "email_send" && entry.approval === "approved")
  );

  const blocked = await createChiefTooling({
    userId: "user-a",
    policy: policyWith([Capability.EMAIL_READ]),
    audit: new MemoryAuditLog(),
    connectors,
  });
  const refused = await blocked.executor.execute(
    { callId: "no", name: "email_send", arguments: { to: ADDRESS, subject: "Hello" } },
    { userId: "user-a", agentId: "chief", mutationApproved: true }
  );
  assert.equal(refused.isError, true);
  assert.match(refused.output, /email:send/);
  assert.equal(sends.length, 1);

  const specs = granted.specs;
  const calls = [{ callId: "s3", name: "email_send", arguments: {} }];
  const classified = classifyToolCalls(calls, specs);
  assert.ok(classified.mutationIds.includes("s3"));
  const coordinator = new ApprovalCoordinator();
  coordinator.sessionStart("sess-9");
  const decision = coordinator.authorize("sess-9", calls, classified.mutationIds);
  assert.equal(decision.type, "approval");
});

test("Claude, GPT, and Grok receive the same capability surface", async () => {
  const policy = policyWith([
    Capability.MEMORY_READ,
    Capability.WEB_SEARCH,
    Capability.CODE_READ,
    Capability.CAPABILITY_READ,
    Capability.FINANCE_READ,
  ]);
  const snapshots = [XAI_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID].map((provider) =>
    discoverCapabilities({
      policy,
      provider,
      module02Read: true,
      webCredentialPresent: true,
      codeEnabled: true,
    })
  );
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.deepEqual(snapshots[1], snapshots[2]);
  assert.equal(JSON.stringify(snapshots[0]).includes("anthropic"), false);
  assert.equal(JSON.stringify(snapshots[0]).includes("openai"), false);
  const specs = createChiefTools().map((tool) => tool.spec);
  const surfaces = [XAI_PROVIDER_ID, ANTHROPIC_PROVIDER_ID, OPENAI_PROVIDER_ID].map(() =>
    Object.keys(toolSpecsToAiTools(specs)).sort()
  );
  assert.deepEqual(surfaces[0], surfaces[1]);
  assert.deepEqual(surfaces[1], surfaces[2]);
  assert.ok(surfaces[0].includes("capability_discover"));
  assert.ok(surfaces[0].includes("code_read"));
  assert.ok(surfaces[0].includes("finance_summary"));
  assert.ok(surfaces[0].includes("web_search"));
  assert.equal(surfaces[0].includes("email_search"), false);
  assert.equal(surfaces[0].includes("shell_exec"), false);
});

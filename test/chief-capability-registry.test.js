// Capability registry. Descriptors carry governance metadata. Handlers stay
// on the server, and ToolExecutor remains the only execution path.

import test from "node:test";
import assert from "node:assert/strict";

import { Effect } from "../server/chief/capabilities/descriptor.js";
import { CapabilityRegistry } from "../server/chief/capabilities/registry.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { ApprovalCoordinator, ApprovalPolicy } from "../server/chief/runtime/approvals.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import {
  classifyToolCalls,
  toolSpecsToAiTools,
  TurnMachine,
} from "../server/chief/runtime/turn.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import { MemoryModuleAccess } from "../server/chief/security/module-access.js";
import {
  createChiefCapabilityRegistry,
  createChiefTooling,
  createChiefTools,
} from "../server/chief/tools/builtin.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import { MemoryScheduleStore } from "../server/chief/tools/schedule-store.js";

function textStream(parts) {
  return {
    fullStream: (async function* stream() {
      for (const part of parts) yield part;
    })(),
    finalize: async () => ({
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      content: "",
      tool_calls: [],
      finish_reason: "stop",
    }),
  };
}

function scriptedEngine(steps) {
  let index = 0;
  return {
    async openStream() {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      return {
        resolution: { modelKey: "scripted", caller: { kind: "user_turn" } },
        fullStream: textStream(step).fullStream,
        finalize: textStream(step).finalize,
      };
    },
  };
}

function policyWith(capabilities) {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  for (const capability of capabilities) policy.grant("chief", capability);
  return policy;
}

test("descriptors register, look up, and reject duplicates and bad schemas", () => {
  const registry = new CapabilityRegistry();
  const defined = registry.register({
    descriptor: {
      name: "example_read",
      description: "Read an example.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "string" },
      subsystem: "example",
      effect: "read",
      requiredCapabilities: ["example:read"],
      confirmation: "none",
      audit: "deny_only",
      exposure: "baseline",
    },
    execute: async () => ({ output: "ok" }),
  });
  assert.equal(defined.effect, "read");
  assert.equal(typeof defined.execute, "undefined");
  assert.equal(registry.get("example_read").name, "example_read");
  assert.equal(JSON.stringify(registry.get("example_read")).includes("execute"), false);
  assert.throws(
    () => registry.register({ descriptor: defined, execute: async () => ({}) }),
    /already registered/
  );
  assert.throws(
    () =>
      registry.register({
        descriptor: { ...defined, name: "with_handler", execute() {} },
        execute: async () => ({}),
      }),
    /must not include a handler/
  );
  assert.throws(
    () =>
      registry.register({
        descriptor: {
          name: "bad_schema",
          description: "Broken.",
          inputSchema: { type: "number" },
          outputSchema: { type: "string" },
          subsystem: "example",
          effect: "read",
          requiredCapabilities: ["example:read"],
          confirmation: "none",
          audit: "deny_only",
          exposure: "baseline",
        },
        execute: async () => ({}),
      }),
    /inputSchema/
  );
  assert.equal(registry.get("missing"), null);
  assert.deepEqual(
    registry.search("example").map((descriptor) => descriptor.name),
    ["example_read"]
  );
  assert.throws(() => registry.registerFromModel(), /cannot register/);
  assert.throws(() => registry.grantFromModel(), /cannot change capability permissions/);
});

test("the model cannot supply a handler or bypass ToolExecutor", () => {
  assert.throws(
    () => toolSpecsToAiTools([{ name: "injected", description: "no", execute() {} }]),
    /refusing executable tool spec/
  );
  const specs = createChiefTools().map((tool) => tool.spec);
  for (const spec of specs) {
    assert.equal(typeof spec.execute, "undefined");
    assert.equal(typeof spec.effect, "string");
  }
  assert.equal(
    specs.some((spec) => spec.name === "finance_write"),
    false
  );
  const codeRead = specs.find((spec) => spec.name === "code_read");
  assert.equal(codeRead.effect, "read");
  assert.equal(typeof codeRead.execute, "undefined");
  assert.equal(
    specs.some((spec) => spec.name === "code_write" || spec.name === "shell_exec"),
    false
  );
});

test("unknown capabilities fail closed and explicit denies win", async () => {
  const policy = policyWith([Capability.SCHEDULE_READ]);
  policy.deny("chief", Capability.SCHEDULE_READ);
  const tooling = await createChiefTooling({
    userId: "user-a",
    policy,
    audit: new MemoryAuditLog(),
    stores: { schedule: new MemoryScheduleStore() },
  });
  const unknown = await tooling.executor.execute(
    { callId: "u", name: "not_a_capability", arguments: {} },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(unknown.isError, true);
  assert.match(unknown.output, /Unknown tool/);
  const denied = await tooling.executor.execute(
    { callId: "l", name: "schedule_list", arguments: {} },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(denied.isError, true);
  assert.match(denied.output, /schedule:read/);
});

test("schedule reads and writes use separate grants and keep their effects", async () => {
  const tools = createChiefTools();
  const list = tools.find((tool) => tool.spec.name === "schedule_list").spec;
  const cancel = tools.find((tool) => tool.spec.name === "schedule_cancel").spec;
  const update = tools.find((tool) => tool.spec.name === "schedule_update").spec;
  assert.equal(list.effect, Effect.READ);
  assert.equal(list.requiresConfirmation, false);
  assert.deepEqual(list.requiredCapabilities, [Capability.SCHEDULE_READ]);
  assert.deepEqual(CHIEF_TOOL_INVENTORY.schedule_list, [Capability.SCHEDULE_READ]);
  assert.equal(update.effect, Effect.WRITE);
  assert.equal(update.confirmation, "required");
  assert.equal(cancel.effect, Effect.DESTRUCTIVE);
  assert.equal(cancel.audit, "full");
  const readOnly = await createChiefTooling({
    userId: "user-a",
    policy: policyWith([Capability.SCHEDULE_READ]),
    audit: new MemoryAuditLog(),
    stores: { schedule: new MemoryScheduleStore() },
  });
  const listed = await readOnly.executor.execute(
    { callId: "l", name: "schedule_list", arguments: { userId: "someone-else" } },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(listed.isError, false);
  const blockedWrite = await readOnly.executor.execute(
    {
      callId: "c",
      name: "schedule_cancel",
      arguments: { taskId: "task-1", userId: "someone-else" },
    },
    { userId: "user-a", agentId: "chief", mutationApproved: true }
  );
  assert.equal(blockedWrite.isError, true);
  assert.match(blockedWrite.output, /schedule:create/);
});

test("destructive and high-impact capabilities require a fresh confirmation", () => {
  const specs = createChiefTools().map((tool) => tool.spec);
  const calls = [
    { callId: "cancel", name: "schedule_cancel", arguments: { taskId: "task-1" } },
    { callId: "rename", name: "schedule_update", arguments: { taskId: "task-1" } },
    { callId: "access", name: "freedom_financial_access_set", arguments: { enabled: true } },
  ];
  const classification = classifyToolCalls(calls, specs);
  assert.deepEqual(classification.explicitIds, ["cancel", "access"]);
  assert.ok(classification.mutationIds.includes("rename"));

  const approvals = new ApprovalCoordinator(ApprovalPolicy.FULL_ACCESS);
  approvals.sessionStart("session");
  const first = approvals.authorize("session", calls, classification.mutationIds, {
    explicitCallIds: classification.explicitIds,
  });
  assert.equal(first.type, "approval");
  assert.deepEqual(first.request.callIds.sort(), ["access", "cancel"]);
  assert.equal(first.permissions.forCall("rename").mutation, true);

  approvals.resolve(
    "session",
    calls,
    first.request.callIds,
    { type: "approved_for_session" },
    first.permissions,
    {
      explicitCallIds: classification.explicitIds,
    }
  );
  const second = approvals.authorize("session", calls, classification.mutationIds, {
    explicitCallIds: classification.explicitIds,
  });
  assert.equal(second.type, "approval");
  assert.deepEqual(second.request.callIds.sort(), ["access", "cancel"]);
});

test("conversation capabilities use the checkpoint store and ignore a model user id", async () => {
  const store = new MemoryCheckpointStore();
  const owned = await store.createSession({ userId: "user-a", context: {} });
  store.sessions.get(owned.id).title = "Old title";
  const other = await store.createSession({ userId: "user-b", context: {} });
  store.sessions.get(other.id).title = "Other";
  const audit = new MemoryAuditLog();
  const tooling = await createChiefTooling({
    userId: "user-a",
    policy: policyWith([
      Capability.CONVERSATION_READ,
      Capability.CONVERSATION_WRITE,
      Capability.CONVERSATION_DELETE,
    ]),
    audit,
    stores: { checkpoints: store },
  });
  const context = {
    userId: "user-a",
    agentId: "chief",
    sessionId: owned.id,
    mutationApproved: true,
  };
  const renamed = await tooling.executor.execute(
    {
      callId: "r",
      name: "conversation_rename",
      arguments: { title: "CHIEF Architecture", userId: "user-b" },
    },
    context
  );
  assert.equal(renamed.isError, false);
  assert.match(renamed.output, /CHIEF Architecture/);
  assert.equal(store.sessions.get(other.id).title, "Other");
  const archived = await tooling.executor.execute(
    { callId: "a", name: "conversation_archive", arguments: { userId: "user-b" } },
    context
  );
  assert.match(archived.output, /"archived":true/);
  const restored = await tooling.executor.execute(
    { callId: "s", name: "conversation_restore", arguments: {} },
    context
  );
  assert.match(restored.output, /"archived":false/);
  const removed = await tooling.executor.execute(
    {
      callId: "d",
      name: "conversation_delete",
      arguments: { session_id: owned.id, userId: "user-b" },
    },
    context
  );
  assert.match(removed.output, /"deleted":true/);
  assert.equal(store.sessions.has(owned.id), false);
  assert.equal(store.sessions.has(other.id), true);
  assert.ok(
    audit.entries.some(
      (entry) => entry.action === "capability.executed" && entry.resource === "conversation_delete"
    )
  );
});

test("Freedom Financial remains a separate switch from the finance grant", async () => {
  const access = new MemoryModuleAccess();
  const tooling = await createChiefTooling({
    userId: "user-a",
    policy: policyWith([Capability.FINANCE_READ, Capability.MODULE_ACCESS]),
    audit: new MemoryAuditLog(),
    moduleAccess: access,
  });
  const summary = tooling.tools.find((tool) => tool.spec.name === "finance_summary");
  const toggle = tooling.tools.find((tool) => tool.spec.name === "freedom_financial_access_set");
  assert.equal(summary.spec.effect, Effect.READ);
  assert.equal(toggle.spec.effect, Effect.HIGH_IMPACT);
  const blocked = await tooling.executor.execute(
    { callId: "f", name: "finance_summary", arguments: {} },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(blocked.isError, true);
  const enabled = await tooling.executor.execute(
    {
      callId: "m",
      name: "freedom_financial_access_set",
      arguments: { enabled: true, userId: "user-b" },
    },
    { userId: "user-a", agentId: "chief", mutationApproved: true }
  );
  assert.equal(enabled.isError, false);
  assert.equal(await access.isFreedomFinancialReadEnabled("user-a"), true);
  assert.equal(await access.isFreedomFinancialReadEnabled("user-b"), false);
});

test("deleting the current conversation confirms, then removes that session", async () => {
  const store = new MemoryCheckpointStore();
  const session = await store.createSession({ userId: "user-a", context: {} });
  const tooling = await createChiefTooling({
    userId: "user-a",
    policy: policyWith([Capability.CONVERSATION_DELETE]),
    audit: new MemoryAuditLog(),
    stores: { checkpoints: store },
  });
  const engine = scriptedEngine([
    [{ type: "tool-call", toolCallId: "d1", toolName: "conversation_delete", input: {} }],
    [{ type: "text-delta", text: "Deleted." }],
  ]);
  const machine = new TurnMachine({
    store,
    engine,
    approvals: new ApprovalCoordinator(),
    toolExecutor: tooling.executor,
  });
  const suspended = await machine.run({
    userId: "user-a",
    sessionId: session.id,
    toolSpecs: tooling.specs,
    submission: {
      id: "sub-1",
      op: { type: "message", message: { text: "Delete this conversation." } },
    },
  });
  assert.equal(suspended.status, "suspended");
  assert.equal(store.sessions.has(session.id), true);
  const finished = await machine.run({
    userId: "user-a",
    sessionId: session.id,
    toolSpecs: tooling.specs,
    submission: {
      id: "sub-2",
      op: {
        type: "exec_approval",
        id: suspended.checkpoint.pendingApproval.id,
        decision: "approved",
      },
    },
  });
  assert.equal(finished.status, "completed");
  assert.equal(store.sessions.has(session.id), false);
});

test("an unregistered executor still rejects names that are not in its tool map", async () => {
  const executor = new ToolExecutor({
    tools: [],
    policy: new CapabilityPolicy({ defaultDeny: true }),
    audit: new MemoryAuditLog(),
  });
  const result = await executor.execute(
    { callId: "x", name: "conversation_delete", arguments: {} },
    { userId: "user-a", agentId: "chief", mutationApproved: true }
  );
  assert.equal(result.isError, true);
  assert.match(result.output, /Unknown tool/);
  const registry = createChiefCapabilityRegistry();
  assert.equal(registry.resolve("conversation_delete").descriptor.effect, Effect.DESTRUCTIVE);
  assert.equal(typeof registry.get("conversation_delete").execute, "undefined");
});

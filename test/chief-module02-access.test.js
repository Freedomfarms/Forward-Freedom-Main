// Per-user Module 02 read access. The flag defaults off, the UI and the
// confirmed CHIEF tool write the same row, and the finance tools stay read-only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleChiefModuleAccess } from "../api/chief/module-access.js";
import { assembleSystemPrompt, module02AccessGuidance } from "../server/chief/context/assemble.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import {
  MemoryModuleAccess,
  MODULE02_READ_DISABLED,
  PrismaModuleAccess,
} from "../server/chief/security/module-access.js";
import { createChiefTools } from "../server/chief/tools/builtin.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import { statusForToolName } from "../src/utils/chiefProtocol.js";
import {
  isModule02Tab,
  MODULE02_ACCESS_OFF_COPY,
  MODULE02_ACCESS_ON_COPY,
  module02AccessCopy,
  module02AccessPayload,
} from "../src/utils/module02AccessCopy.js";

const USER_A = "user-a";
const USER_B = "user-b";
const ONLY_A = "ONLY_USER_A_CASH_42";
const ONLY_B = "ONLY_USER_B_CASH_7";

const FINANCE_READS = ["finance_summary", "workspace_plan_summary"];
const WRITE_NAMES = [
  "create_transaction",
  "edit_transaction",
  "delete_transaction",
  "edit_budget",
  "update_budget",
  "change_category",
  "add_account",
  "delete_account",
  "finance_write",
  "update_transaction",
];

function policy() {
  const next = new CapabilityPolicy({ defaultDeny: true });
  for (const capability of [
    Capability.MEMORY_READ,
    Capability.MEMORY_WRITE,
    Capability.SCHEDULE_CREATE,
    Capability.FINANCE_READ,
    Capability.SKILL_READ,
    Capability.WEB_SEARCH,
    Capability.MODULE_ACCESS,
  ]) {
    next.grant("_default", capability);
  }
  return next;
}

function scripted(steps) {
  let index = 0;
  const seen = [];
  return {
    seen,
    availableModelKeys() {
      return ["claude", "gpt", "grok"];
    },
    async openStream(messages, options) {
      seen.push({
        model: options?.model ?? null,
        toolNames: Object.keys(options?.tools ?? {}),
        system: (messages ?? []).map((item) => item?.content ?? "").join("\n"),
      });
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      return {
        fullStream: (async function* stream() {
          for (const part of step.parts ?? []) yield part;
          if (step.text) yield { type: "text-delta", text: step.text };
        })(),
        finalize: async () => ({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          content: step.text ?? "",
          tool_calls: [],
          finish_reason: "stop",
        }),
      };
    },
  };
}

function message(text, id) {
  return { id, op: { type: "message", message: { text } } };
}

function approval(id, decision = "approved") {
  return { id: `decision-${id}`, op: { type: "exec_approval", id, decision } };
}

function world({ enabled = [] } = {}) {
  const loads = [];
  const access = new MemoryModuleAccess(enabled.map((userId) => [userId, true]));
  const tools = createChiefTools({
    loadFinance: async (userId) => {
      loads.push(userId);
      return { cashPosition: userId === USER_A ? ONLY_A : ONLY_B };
    },
    loadWorkspace: async (userId) => {
      loads.push(`plan:${userId}`);
      return { status: "available", budgetRowCount: userId === USER_A ? 3 : 9 };
    },
    search: {
      async search() {
        return {
          ok: true,
          provider: "brave",
          query: "markets",
          results: [
            { title: "Public markets", url: "https://example.com/markets", snippet: "open" },
          ],
        };
      },
    },
    moduleAccess: access,
  });
  const executor = new ToolExecutor({
    tools,
    policy: policy(),
    audit: new MemoryAuditLog(),
    inventory: CHIEF_TOOL_INVENTORY,
  });
  return { loads, access, tools, executor, specs: tools.map((tool) => tool.spec) };
}

function contextAssemblerFor(access) {
  return async function contextAssembler({ userId, availableTools }) {
    let module02Read = false;
    try {
      if (userId) module02Read = (await access.isModule02ReadEnabled(userId)) === true;
    } catch {
      module02Read = false;
    }
    return assembleSystemPrompt({
      userId,
      availableTools,
      facts: {
        async read() {
          return [];
        },
      },
      module02Read,
    });
  };
}

function machine(ctx, steps) {
  const engine = scripted(steps);
  const turn = new TurnMachine({
    store: ctx.store,
    engine,
    toolExecutor: ctx.executor,
    contextAssembler: contextAssemblerFor(ctx.access),
  });
  turn.engine = engine;
  return turn;
}

function apiRequest(method, body) {
  return {
    method,
    body,
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
  };
}

function mockResponse() {
  const state = { statusCode: null, body: null };
  return {
    state,
    response: {
      setHeader() {},
      status(code) {
        state.statusCode = code;
        return this;
      },
      json(body) {
        state.body = body;
        return this;
      },
    },
  };
}

test("Module 02 access defaults off and the UI writes the same row CHIEF reads", async () => {
  const access = new MemoryModuleAccess();
  assert.equal(await access.isModule02ReadEnabled(USER_A), false);
  assert.equal(await access.isModule02ReadEnabled(USER_B), false);

  const off = mockResponse();
  await handleChiefModuleAccess(apiRequest("GET"), off.response, {
    store: access,
    authenticate: async () => ({ uid: USER_A }),
  });
  assert.equal(off.state.statusCode, 200);
  assert.deepEqual(off.state.body, { module02Read: false, writeAccess: false });

  const on = mockResponse();
  await handleChiefModuleAccess(
    apiRequest("POST", { module02Read: true, userId: USER_B }),
    on.response,
    { store: access, authenticate: async () => ({ uid: USER_A }) }
  );
  assert.equal(on.state.statusCode, 200);
  assert.deepEqual(on.state.body, { module02Read: true, writeAccess: false });
  assert.equal(await access.isModule02ReadEnabled(USER_A), true);
  assert.equal(await access.isModule02ReadEnabled(USER_B), false);

  const other = mockResponse();
  await handleChiefModuleAccess(apiRequest("GET"), other.response, {
    store: access,
    authenticate: async () => ({ uid: USER_B }),
  });
  assert.deepEqual(other.state.body, { module02Read: false, writeAccess: false });

  const disabled = mockResponse();
  await handleChiefModuleAccess(apiRequest("POST", { module02Read: false }), disabled.response, {
    store: access,
    authenticate: async () => ({ uid: USER_A }),
  });
  assert.equal(disabled.state.body.module02Read, false);
  assert.equal(await access.isModule02ReadEnabled(USER_A), false);

  const ambiguous = mockResponse();
  await handleChiefModuleAccess(apiRequest("POST", { module02Read: "true" }), ambiguous.response, {
    store: access,
    authenticate: async () => ({ uid: USER_A }),
  });
  assert.equal(ambiguous.state.statusCode, 400);
  assert.equal(await access.isModule02ReadEnabled(USER_A), false);

  const denied = mockResponse();
  await handleChiefModuleAccess(apiRequest("POST", { module02Read: true }), denied.response, {
    authenticate: async () => {
      const error = new Error("Unauthorized");
      error.status = 401;
      throw error;
    },
  });
  assert.equal(denied.state.statusCode, 401);
  assert.equal(denied.state.body.message, "Unauthorized");
  assert.equal(await access.isModule02ReadEnabled(USER_A), false);

  const blocked = mockResponse();
  await handleChiefModuleAccess(apiRequest("POST", { module02Read: true }), blocked.response, {
    store: access,
    authenticate: async () => {
      const error = new Error("This account has been disabled.");
      error.status = 403;
      throw error;
    },
  });
  assert.equal(blocked.state.statusCode, 403);
  assert.equal(blocked.state.body.error, "This account has been disabled.");
  assert.equal(blocked.state.body.message, blocked.state.body.error);
  assert.equal(blocked.state.body.writeAccess, undefined);
  assert.equal(await access.isModule02ReadEnabled(USER_A), false);
});

test("the sidebar control is the Module 02 read switch and uses the shared copy", () => {
  assert.equal(isModule02Tab("Command Center"), true);
  assert.equal(isModule02Tab("Transactions"), true);
  assert.equal(isModule02Tab("CHIEF"), false);
  assert.equal(isModule02Tab("Freedom OS"), false);
  assert.equal(isModule02Tab("Admin Usage"), false);
  assert.equal(module02AccessCopy(false), MODULE02_ACCESS_OFF_COPY);
  assert.equal(module02AccessCopy(true), MODULE02_ACCESS_ON_COPY);
  assert.deepEqual(module02AccessPayload(true), { module02Read: true });
  assert.deepEqual(module02AccessPayload(false), { module02Read: false });
  assert.deepEqual(module02AccessPayload("true"), { module02Read: false });

  const layout = readFileSync(new URL("../src/components/Layout.jsx", import.meta.url), "utf8");
  const panel = readFileSync(
    new URL("../src/components/Module02ChiefAccess.jsx", import.meta.url),
    "utf8"
  );
  assert.match(layout, /isModule02Tab\(activeTab\)/);
  assert.match(layout, /Module02ChiefAccess/);
  assert.match(layout, /isDemoMode/);
  assert.match(panel, /CHIEF Access/);
  assert.match(panel, /saveModule02ChiefAccess/);
  assert.match(panel, /fetchModule02ChiefAccess/);
  assert.match(panel, /aria-pressed/);
  assert.doesNotMatch(panel, /deleteTransaction|updateBudget|addAccount|\/api\/workspace/);
});

test("finance tools stay read-only and refuse Module 02 data while access is off", async () => {
  const ctx = world();
  for (const name of FINANCE_READS) {
    const spec = ctx.specs.find((item) => item.name === name);
    assert.equal(spec.requiresConfirmation, false);
    assert.equal(spec.category, "finance");
    assert.deepEqual([...spec.requiredCapabilities], [Capability.FINANCE_READ]);
  }
  for (const spec of ctx.specs) {
    if (spec.category === "finance") assert.ok(FINANCE_READS.includes(spec.name));
  }
  for (const name of WRITE_NAMES) {
    assert.equal(CHIEF_TOOL_INVENTORY[name], undefined);
    assert.equal(
      ctx.specs.some((spec) => spec.name === name),
      false
    );
  }
  assert.equal(
    ctx.specs.find((spec) => spec.name === "module02_access_set").requiresConfirmation,
    true
  );

  for (const name of FINANCE_READS) {
    const blocked = await ctx.executor.execute(
      { callId: name, name, arguments: { userId: USER_B } },
      { userId: USER_A }
    );
    assert.equal(blocked.isError, true);
    assert.equal(blocked.output, MODULE02_READ_DISABLED);
    assert.equal(blocked.output.includes(ONLY_A), false);
    assert.equal(blocked.output.includes(ONLY_B), false);
  }
  assert.deepEqual(ctx.loads, []);

  const status = await ctx.executor.execute(
    { callId: "status", name: "module02_access_status", arguments: { userId: USER_B } },
    { userId: USER_A }
  );
  assert.deepEqual(JSON.parse(status.output), { module02Read: false, writeAccess: false });
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), false);

  const silent = await ctx.executor.execute(
    { callId: "set", name: "module02_access_set", arguments: { enabled: true, userId: USER_B } },
    { userId: USER_A, caller: { kind: "schedule" } }
  );
  assert.match(silent.output, /requires confirmation/);
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), false);
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_B), false);

  const coerced = await ctx.executor.execute(
    { callId: "bad", name: "module02_access_set", arguments: { enabled: "true" } },
    { userId: USER_A, mutationApproved: true }
  );
  assert.equal(coerced.isError, true);
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), false);

  const missing = await ctx.executor.execute(
    { callId: "budget", name: "edit_budget", arguments: { amount: 1 } },
    { userId: USER_A, mutationApproved: true }
  );
  assert.equal(missing.isError, true);
  assert.deepEqual(ctx.loads, []);
});

test("an enabled user can read only their own Module 02 data", async () => {
  const ctx = world({ enabled: [USER_A] });
  const summary = await ctx.executor.execute(
    { callId: "f", name: "finance_summary", arguments: { userId: USER_B } },
    { userId: USER_A }
  );
  assert.equal(summary.isError, false);
  assert.equal(JSON.parse(summary.output).cashPosition, ONLY_A);
  assert.equal(summary.output.includes(ONLY_B), false);

  const plan = await ctx.executor.execute(
    { callId: "w", name: "workspace_plan_summary", arguments: { userId: USER_B } },
    { userId: USER_A }
  );
  assert.equal(JSON.parse(plan.output).budgetRowCount, 3);
  assert.deepEqual(ctx.loads, [USER_A, `plan:${USER_A}`]);

  const other = await ctx.executor.execute(
    { callId: "b", name: "finance_summary", arguments: {} },
    { userId: USER_B }
  );
  assert.equal(other.output, MODULE02_READ_DISABLED);
  assert.equal(ctx.loads.includes(USER_B), false);
});

test("the acceptance conversation enables, reads, refuses a write, and disables", async () => {
  const ctx = world();
  ctx.store = new MemoryCheckpointStore();
  const specs = ctx.specs;

  const askOff = machine(ctx, [
    {
      parts: [{ type: "tool-call", toolCallId: "f", toolName: "finance_summary", input: {} }],
    },
    { text: "Freedom Financial read access is currently disabled." },
  ]);
  const position = await askOff.run({
    userId: USER_A,
    submission: message("CHIEF, what's my financial position?", "q1"),
    toolSpecs: specs,
  });
  assert.equal(position.status, "completed");
  assert.deepEqual(ctx.loads, []);
  assert.match(JSON.stringify(position.checkpoint.transcript), /currently disabled/);
  assert.match(askOff.engine.seen[0].system, /is not a request to enable/);
  assert.equal(
    position.checkpoint.transcript.some((item) => JSON.stringify(item).includes(ONLY_A)),
    false
  );

  const enableEngine = scripted([
    {
      parts: [
        {
          type: "tool-call",
          toolCallId: "on",
          toolName: "module02_access_set",
          input: { enabled: true },
        },
      ],
    },
    { text: "Freedom Financial read-only access is on." },
  ]);
  const enableMachine = new TurnMachine({
    store: ctx.store,
    engine: enableEngine,
    toolExecutor: ctx.executor,
    contextAssembler: contextAssemblerFor(ctx.access),
  });
  const requested = await enableMachine.run({
    userId: USER_A,
    submission: message("CHIEF, turn on my Freedom Financial read-only access.", "q2"),
    toolSpecs: specs,
  });
  assert.equal(requested.status, "suspended");
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), false);
  const enabled = await enableMachine.run({
    userId: USER_A,
    sessionId: requested.sessionId,
    submission: approval(requested.checkpoint.pendingApproval.id),
    toolSpecs: specs,
  });
  assert.equal(enabled.status, "completed");
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), true);
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_B), false);
  assert.match(enabled.checkpoint.transcript.at(-1).content, /read-only access is on/);

  const readMachine = machine(ctx, [
    {
      parts: [
        {
          type: "tool-call",
          toolCallId: "f2",
          toolName: "finance_summary",
          input: { userId: USER_B },
        },
      ],
    },
    { text: `Your cash position is ${ONLY_A}.` },
  ]);
  const read = await readMachine.run({
    userId: USER_A,
    submission: message("What's my financial position?", "q3"),
    toolSpecs: specs,
  });
  assert.equal(read.status, "completed");
  assert.deepEqual(ctx.loads, [USER_A]);
  assert.match(read.checkpoint.transcript.at(-1).content, new RegExp(ONLY_A));
  assert.equal(JSON.stringify(read.checkpoint.transcript).includes(ONLY_B), false);
  assert.match(readMachine.engine.seen[0].system, /read access is on/);
  assert.match(readMachine.engine.seen[0].system, /write access is not currently available/);
  assert.match(readMachine.engine.seen[0].system, /is not a request to enable/);

  const write = await machine(ctx, [
    { text: "Freedom Financial write access is not currently available." },
  ]).run({
    userId: USER_A,
    submission: message("Change my budget.", "q4"),
    toolSpecs: specs,
  });
  assert.equal(write.status, "completed");
  assert.match(
    write.checkpoint.transcript.at(-1).content,
    /write access is not currently available/
  );
  assert.deepEqual(ctx.loads, [USER_A]);

  const disableEngine = scripted([
    {
      parts: [
        {
          type: "tool-call",
          toolCallId: "off",
          toolName: "module02_access_set",
          input: { enabled: false },
        },
      ],
    },
    { text: "Freedom Financial read access is off." },
  ]);
  const disableMachine = new TurnMachine({
    store: ctx.store,
    engine: disableEngine,
    toolExecutor: ctx.executor,
    contextAssembler: contextAssemblerFor(ctx.access),
  });
  const disableRequest = await disableMachine.run({
    userId: USER_A,
    submission: message("CHIEF, turn off my Freedom Financial access.", "q5"),
    toolSpecs: specs,
  });
  assert.equal(disableRequest.status, "suspended");
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), true);
  const disabled = await disableMachine.run({
    userId: USER_A,
    sessionId: disableRequest.sessionId,
    submission: approval(disableRequest.checkpoint.pendingApproval.id),
    toolSpecs: specs,
  });
  assert.equal(disabled.status, "completed");
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), false);

  const again = await machine(ctx, [
    {
      parts: [{ type: "tool-call", toolCallId: "f3", toolName: "finance_summary", input: {} }],
    },
    { text: "Freedom Financial read access is currently disabled." },
  ]).run({
    userId: USER_A,
    submission: message("What's my financial position?", "q6"),
    toolSpecs: specs,
  });
  assert.equal(again.status, "completed");
  assert.deepEqual(ctx.loads, [USER_A]);
  assert.match(JSON.stringify(again.checkpoint.transcript), /currently disabled/);
  assert.equal(JSON.stringify(again.checkpoint.transcript).includes(ONLY_A), false);
});

test("a question about Module 02 does not enable access", async () => {
  const ctx = world();
  ctx.store = new MemoryCheckpointStore();
  const askedMachine = machine(ctx, [
    {
      parts: [
        { type: "tool-call", toolCallId: "st", toolName: "module02_access_status", input: {} },
      ],
    },
    { text: "Freedom Financial read access is off." },
  ]);
  const asked = await askedMachine.run({
    userId: USER_A,
    submission: message("Can you access Freedom Financial?", "ask"),
    toolSpecs: ctx.specs,
  });
  assert.equal(asked.status, "completed");
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), false);
  assert.match(askedMachine.engine.seen[0].system, /is not a request to enable/);

  const about = await machine(ctx, [
    { text: "Freedom Financial is your financial workspace." },
  ]).run({
    userId: USER_A,
    submission: message("Tell me about Freedom Financial", "about"),
    toolSpecs: ctx.specs,
  });
  assert.equal(about.status, "completed");
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), false);
  assert.equal(module02AccessGuidance(null), "");
  assert.match(module02AccessGuidance(["finance_summary"]), /read access is off/);
  assert.match(
    module02AccessGuidance(["finance_summary"]),
    /write access is not currently available/
  );
  assert.match(
    module02AccessGuidance(["finance_summary"], { module02Read: false }),
    /read access is off/
  );
  assert.match(
    module02AccessGuidance(["finance_summary"], { module02Read: true }),
    /read access is on/
  );
  assert.match(
    module02AccessGuidance(["finance_summary"], { module02Read: true }),
    /write access is not currently available/
  );
  assert.doesNotMatch(
    module02AccessGuidance(["finance_summary"], { module02Read: true }),
    /read access is off/
  );
});

test("Claude, GPT, and Grok share the user flag and web search stays separate", async () => {
  const ctx = world({ enabled: [USER_A] });
  ctx.store = new MemoryCheckpointStore();
  let sessionId = null;
  for (const model of ["claude", "gpt", "grok"]) {
    const selected = await machine(ctx, [{ text: model }]).run({
      userId: USER_A,
      sessionId,
      submission: { id: `model-${model}`, op: { type: "set_model", route: model } },
      toolSpecs: ctx.specs,
    });
    assert.equal(selected.status, "completed");
    sessionId = selected.sessionId;
    const answerMachine = machine(ctx, [
      {
        parts: [{ type: "tool-call", toolCallId: model, toolName: "finance_summary", input: {} }],
      },
      { text: ONLY_A },
    ]);
    const answer = await answerMachine.run({
      userId: USER_A,
      sessionId,
      submission: message("What's my financial position?", `ask-${model}`),
      toolSpecs: ctx.specs,
    });
    assert.equal(answer.status, "completed");
    assert.equal(answerMachine.engine.seen.at(-1).model, model);
    assert.ok(answerMachine.engine.seen.at(-1).toolNames.includes("finance_summary"));
    assert.ok(answerMachine.engine.seen.at(-1).toolNames.includes("web_search"));
    assert.ok(answerMachine.engine.seen.at(-1).toolNames.includes("module02_access_set"));
    for (const name of WRITE_NAMES) {
      assert.equal(answerMachine.engine.seen.at(-1).toolNames.includes(name), false);
    }
    assert.match(answer.checkpoint.transcript.at(-1).content, new RegExp(ONLY_A));
  }
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), true);
  assert.deepEqual(ctx.loads, [USER_A, USER_A, USER_A]);

  await ctx.access.setModule02ReadEnabled(USER_A, false);
  for (const model of ["claude", "gpt", "grok"]) {
    const deniedMachine = machine(ctx, [
      {
        parts: [
          { type: "tool-call", toolCallId: `${model}-off`, toolName: "finance_summary", input: {} },
        ],
      },
      { text: "Freedom Financial read access is currently disabled." },
    ]);
    const denied = await deniedMachine.run({
      userId: USER_A,
      submission: message("What's my financial position?", `off-${model}`),
      toolSpecs: ctx.specs,
    });
    assert.match(JSON.stringify(denied.checkpoint.transcript), /currently disabled/);
    assert.equal(deniedMachine.engine.seen.at(-1).model, null);
  }
  assert.deepEqual(ctx.loads, [USER_A, USER_A, USER_A]);

  const search = await ctx.executor.execute(
    { callId: "web", name: "web_search", arguments: { query: "markets" } },
    { userId: USER_A }
  );
  assert.equal(search.isError, false);
  assert.match(search.output, /Public markets/);
  assert.equal(await ctx.access.isModule02ReadEnabled(USER_A), false);

  const memory = await ctx.executor.execute(
    { callId: "mem", name: "memory_read", arguments: { query: "notes" } },
    { userId: USER_A }
  );
  assert.equal(memory.isError, false);
  assert.equal(statusForToolName("module02_access_status"), "Checking Freedom Financial access");
  assert.equal(statusForToolName("module02_access_set"), "Updating Freedom Financial access");
  assert.equal(statusForToolName("web_search"), "CHIEF is searching the web...");
});

test("user B cannot read user A's Module 02 data through a conversation", async () => {
  const ctx = world({ enabled: [USER_A, USER_B] });
  ctx.store = new MemoryCheckpointStore();
  const a = await machine(ctx, [
    { parts: [{ type: "tool-call", toolCallId: "a", toolName: "finance_summary", input: {} }] },
    { text: ONLY_A },
  ]).run({
    userId: USER_A,
    submission: message("What's my financial position?", "a"),
    toolSpecs: ctx.specs,
  });
  const b = await machine(ctx, [
    {
      parts: [
        {
          type: "tool-call",
          toolCallId: "b",
          toolName: "finance_summary",
          input: { userId: USER_A },
        },
      ],
    },
    { text: ONLY_B },
  ]).run({
    userId: USER_B,
    submission: message("What's my financial position?", "b"),
    toolSpecs: ctx.specs,
  });
  assert.match(a.checkpoint.transcript.at(-1).content, new RegExp(ONLY_A));
  assert.equal(JSON.stringify(b.checkpoint.transcript).includes(ONLY_A), false);
  assert.match(b.checkpoint.transcript.at(-1).content, new RegExp(ONLY_B));
  assert.deepEqual(ctx.loads, [USER_A, USER_B]);
});

test("the database store is per user and fails closed when the table is missing", async () => {
  const rows = new Map();
  const seen = [];
  const store = new PrismaModuleAccess({
    withUser: async (userId, fn) => {
      seen.push(userId);
      return fn({
        chiefModuleAccess: {
          async findUnique({ where }) {
            assert.equal(where.userId, userId);
            return rows.has(where.userId) ? { module02Read: rows.get(where.userId) } : null;
          },
          async upsert({ where, create, update }) {
            assert.equal(where.userId, userId);
            assert.equal(create.userId, userId);
            rows.set(userId, update.module02Read);
            return { userId, module02Read: update.module02Read };
          },
        },
      });
    },
  });
  assert.equal(await store.isModule02ReadEnabled(USER_A), false);
  await store.setModule02ReadEnabled(USER_A, true);
  assert.equal(await store.isModule02ReadEnabled(USER_B), false);
  assert.equal(await store.isModule02ReadEnabled(USER_A), true);
  assert.deepEqual(seen, [USER_A, USER_A, USER_B, USER_A]);

  const missing = new PrismaModuleAccess({
    withUser: async () => {
      const error = new Error('relation "chief_module_access" does not exist');
      error.code = "P2021";
      throw error;
    },
  });
  assert.equal(await missing.isModule02ReadEnabled(USER_A), false);
  await assert.rejects(missing.setModule02ReadEnabled(USER_A, true), /not available/);
});

test("existing Module 02 reads and web search are not replaced", () => {
  const aggregates = readFileSync(
    new URL("../server/finance/aggregates.js", import.meta.url),
    "utf8"
  );
  const workspace = readFileSync(new URL("../api/workspace.js", import.meta.url), "utf8");
  const web = readFileSync(new URL("../server/chief/tools/web-search.js", import.meta.url), "utf8");
  assert.doesNotMatch(aggregates, /module02Read|chief_module_access/);
  assert.doesNotMatch(workspace, /module02Read|chief_module_access/);
  assert.doesNotMatch(web, /module02Read|module02_access/);
  assert.match(
    readFileSync(new URL("../server/chief/tools/builtin.js", import.meta.url), "utf8"),
    /denyUnlessModule02Read/
  );
});

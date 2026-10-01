// CHIEF conversation management. Three permissions default off and stay
// independent. Tools use the existing checkpoint store.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handleChiefConversation } from "../api/chief/conversation.js";
import { handleChiefConversationAccess } from "../api/chief/conversation-access.js";
import { handleChiefHistory } from "../api/chief/history.js";
import { handleChiefSessions } from "../api/chief/sessions.js";
import { assembleSystemPrompt, conversationGuidance } from "../server/chief/context/assemble.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import {
  CONVERSATION_DELETE_DISABLED,
  CONVERSATION_ORGANIZE_DISABLED,
  CONVERSATION_READ_DISABLED,
  MemoryConversationAccess,
  PrismaConversationAccess,
} from "../server/chief/security/conversation-access.js";
import { MemoryModuleAccess } from "../server/chief/security/module-access.js";
import { createChiefTools } from "../server/chief/tools/builtin.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import { statusForToolName } from "../src/utils/chiefProtocol.js";

const USER_A = "user-a";
const USER_B = "user-b";
const NOTE_A = "ONLY_USER_A_HERD_NOTE";
const NOTE_B = "ONLY_USER_B_PRIVATE_NOTE";
const APPROVAL_SECRET = "SECRET_APPROVAL_PAYLOAD";
const TAINT_SECRET = "SECRET_TAINT_LABEL";
const SCHEDULE_SECRET = "SECRET_SCHEDULED_TURN";

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
    Capability.CONVERSATION_READ,
    Capability.CONVERSATION_ORGANIZE,
    Capability.CONVERSATION_DELETE,
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

function approval(id) {
  return { id: `decision-${id}`, op: { type: "exec_approval", id, decision: "approved" } };
}

function counting(store) {
  const calls = [];
  return {
    calls,
    listOwnedSessions: (userId) => store.listOwnedSessions(userId),
    load: async (userId, sessionId) => {
      calls.push(["load", userId, sessionId]);
      return store.load(userId, sessionId);
    },
    renameSession: async (...args) => {
      calls.push(["rename", args[0]]);
      return store.renameSession(...args);
    },
    archiveSession: async (...args) => {
      calls.push(["archive", args[0]]);
      return store.archiveSession(...args);
    },
    restoreSession: async (...args) => {
      calls.push(["restore", args[0]]);
      return store.restoreSession(...args);
    },
    deleteSession: async (...args) => {
      calls.push(["delete", args[0]]);
      return store.deleteSession(...args);
    },
  };
}

function world({ access = new MemoryConversationAccess(), store = new MemoryCheckpointStore() } = {}) {
  const sessions = counting(store);
  const tools = createChiefTools({
    checkpoints: sessions,
    conversationAccess: access,
    moduleAccess: new MemoryModuleAccess(),
    search: {
      async search() {
        return {
          ok: true,
          provider: "brave",
          query: "markets",
          results: [{ title: "Public markets", url: "https://example.com/markets", snippet: "open" }],
        };
      },
    },
  });
  const executor = new ToolExecutor({
    tools,
    policy: policy(),
    audit: new MemoryAuditLog(),
    inventory: CHIEF_TOOL_INVENTORY,
  });
  return { store, sessions, access, tools, executor, specs: tools.map((tool) => tool.spec) };
}

function contextAssembler({ availableTools }) {
  return assembleSystemPrompt({
    availableTools,
    facts: { async read() { return []; } },
  });
}

function machine(ctx, steps) {
  const engine = scripted(steps);
  const turn = new TurnMachine({
    store: ctx.store,
    engine,
    toolExecutor: ctx.executor,
    contextAssembler,
  });
  turn.engine = engine;
  return turn;
}

async function seed(store, userId, sessionId, { title, text, context, pending = false, updatedAt } = {}) {
  await store.createSession({ userId, sessionId, context });
  const loaded = await store.load(userId, sessionId);
  const checkpoint = structuredClone(loaded.checkpoint);
  checkpoint.transcript = text ? [{ role: "user", content: text }] : [];
  checkpoint.pendingApproval = pending
    ? { id: APPROVAL_SECRET, turnId: "turn", calls: [{ name: "memory_write" }] }
    : null;
  checkpoint.sessionTaint = [TAINT_SECRET];
  checkpoint.approvedForSession = ["SECRET_STICKY"];
  if (context) checkpoint.context = context;
  await store.saveWithEvents(userId, sessionId, { checkpoint });
  const record = store.sessions.get(sessionId);
  if (title !== undefined) record.title = title;
  if (updatedAt) record.updatedAt = new Date(updatedAt);
  return sessionId;
}

async function call(ctx, name, args, { userId = USER_A, approved = false } = {}) {
  return ctx.executor.execute(
    { callId: name, name, arguments: args },
    { userId, agentId: "chief", mutationApproved: approved }
  );
}

function mockResponse() {
  const state = { statusCode: 0, body: null };
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

function apiRequest(method, body, query = {}) {
  return { method, body, query, headers: {}, socket: { remoteAddress: "127.0.0.1" } };
}

test("conversation permissions default off and stay independent", async () => {
  const access = new MemoryConversationAccess();
  assert.deepEqual(await access.get(USER_A), {
    conversationRead: false,
    conversationOrganize: false,
    conversationDelete: false,
  });
  const read = await access.set(USER_A, { conversationRead: true });
  assert.equal(read.conversationRead, true);
  assert.equal(read.conversationOrganize, false);
  assert.equal(read.conversationDelete, false);
  const organize = await access.set(USER_A, { conversationOrganize: true });
  assert.equal(organize.conversationDelete, false);
  assert.equal((await access.get(USER_B)).conversationRead, false);
  await assert.rejects(() => access.set(USER_A, { conversationRead: "yes" }), /boolean/);
  assert.equal((await access.get(USER_A)).conversationRead, true);
});

test("read does not load a session while access is off", async () => {
  const ctx = world();
  await seed(ctx.store, USER_A, "mine", { title: "Herd", text: NOTE_A });
  await seed(ctx.store, USER_B, "theirs", { title: "Other", text: NOTE_B });
  const listed = await call(ctx, "conversation_list", {});
  const read = await call(ctx, "conversation_read", { sessionId: "theirs" });
  const searched = await call(ctx, "conversation_search", { query: NOTE_A });
  for (const result of [listed, read, searched]) {
    assert.equal(result.isError, true);
    assert.match(result.output, new RegExp(CONVERSATION_READ_DISABLED));
    assert.equal(result.output.includes(NOTE_A), false);
    assert.equal(result.output.includes(NOTE_B), false);
  }
  assert.deepEqual(ctx.sessions.calls, []);
});

test("read, organize, and delete do not imply one another", async () => {
  const ctx = world({ access: new MemoryConversationAccess([[USER_A, { conversationRead: true }]]) });
  await seed(ctx.store, USER_A, "mine", { title: "Herd", text: NOTE_A });
  const rename = await call(ctx, "conversation_rename", { sessionId: "mine", title: "Renamed" }, { approved: true });
  const remove = await call(ctx, "conversation_delete", { sessionId: "mine" }, { approved: true });
  assert.match(rename.output, new RegExp(CONVERSATION_ORGANIZE_DISABLED));
  assert.match(remove.output, new RegExp(CONVERSATION_DELETE_DISABLED));
  assert.equal(ctx.store.sessions.get("mine").title, "Herd");
  assert.equal(ctx.sessions.calls.some((entry) => entry[0] === "rename" || entry[0] === "delete"), false);

  await ctx.access.set(USER_A, { conversationOrganize: true, conversationRead: false });
  const listed = await call(ctx, "conversation_list", {});
  const archived = await call(ctx, "conversation_archive", { sessionId: "mine" }, { approved: true });
  assert.match(listed.output, new RegExp(CONVERSATION_READ_DISABLED));
  assert.equal(archived.isError, false);
  assert.equal(ctx.store.sessions.get("mine").status, "ARCHIVED");
  const stillThere = await call(ctx, "conversation_delete", { sessionId: "mine" }, { approved: true });
  assert.match(stillThere.output, new RegExp(CONVERSATION_DELETE_DISABLED));
  assert.ok(ctx.store.sessions.has("mine"));
});

test("another user's session id is not a conversation", async () => {
  const ctx = world({
    access: new MemoryConversationAccess([
      [USER_A, { conversationRead: true, conversationOrganize: true, conversationDelete: true }],
    ]),
  });
  await seed(ctx.store, USER_B, "theirs", { title: "Other", text: NOTE_B });
  const read = await call(ctx, "conversation_read", { sessionId: "theirs" });
  const renamed = await call(ctx, "conversation_rename", { sessionId: "theirs", title: "Stolen" }, { approved: true });
  const removed = await call(ctx, "conversation_delete", { sessionId: "theirs" }, { approved: true });
  for (const result of [read, renamed, removed]) {
    assert.equal(result.output, "session not found");
    assert.equal(result.output.includes(NOTE_B), false);
  }
  assert.equal(ctx.store.sessions.get("theirs").title, "Other");
  assert.ok(ctx.sessions.calls.every((entry) => entry[1] === USER_A));
});

test("read and search omit secrets, scheduled sessions, and archived sessions", async () => {
  const ctx = world({ access: new MemoryConversationAccess([[USER_A, { conversationRead: true }]]) });
  await seed(ctx.store, USER_A, "mine", { title: "Herd", text: NOTE_A, updatedAt: "2026-09-20T00:00:00.000Z" });
  await seed(ctx.store, USER_A, "old", { title: "Old herd", text: "earlier note", updatedAt: "2026-08-01T00:00:00.000Z" });
  await seed(ctx.store, USER_A, "box", {
    title: "Archived herd",
    text: "boxed note",
    updatedAt: "2026-09-21T00:00:00.000Z",
  });
  await ctx.store.archiveSession(USER_A, "box");
  await seed(ctx.store, USER_A, "nightly", {
    context: { origin: "schedule", scheduledTaskId: "task-1", runId: "run-1" },
    text: SCHEDULE_SECRET,
  });
  const listed = JSON.parse((await call(ctx, "conversation_list", {})).output);
  assert.deepEqual(
    listed.sessions.map((session) => session.sessionId),
    ["mine", "old"]
  );
  const read = await call(ctx, "conversation_read", { sessionId: "mine" });
  assert.equal(read.output.includes(NOTE_A), true);
  assert.equal(read.output.includes(APPROVAL_SECRET), false);
  assert.equal(read.output.includes(TAINT_SECRET), false);
  assert.equal(read.output.includes("SECRET_STICKY"), false);
  assert.equal(read.output.includes("stateCiphertext"), false);
  const scheduled = await call(ctx, "conversation_read", { sessionId: "nightly" });
  assert.equal(scheduled.output, "session not found");
  assert.equal(scheduled.output.includes(SCHEDULE_SECRET), false);
  const found = JSON.parse((await call(ctx, "conversation_search", { query: "herd" })).output);
  assert.deepEqual(
    found.results.map((row) => row.sessionId),
    ["mine", "old"]
  );
  assert.equal(JSON.stringify(found).includes(SCHEDULE_SECRET), false);
  assert.equal(JSON.stringify(found).includes("boxed note"), false);
  const dated = JSON.parse(
    (await call(ctx, "conversation_search", { after: "2026-09-01T00:00:00.000Z" })).output
  );
  assert.deepEqual(
    dated.results.map((row) => row.sessionId),
    ["mine"]
  );
  assert.deepEqual(dated.results[0].snippets, []);
});

test("rename, archive, and restore require confirmation", async () => {
  const ctx = world({
    access: new MemoryConversationAccess([[USER_A, { conversationOrganize: true }]]),
  });
  await seed(ctx.store, USER_A, "mine", { title: "Herd", text: NOTE_A });
  const blocked = await call(ctx, "conversation_rename", { sessionId: "mine", title: "Pasture" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.output, /confirmation/i);
  assert.equal(ctx.store.sessions.get("mine").title, "Herd");
  const renamed = await call(
    ctx,
    "conversation_rename",
    { sessionId: "mine", title: "Pasture" },
    { approved: true }
  );
  assert.equal(renamed.isError, false);
  assert.equal(ctx.store.sessions.get("mine").title, "Pasture");

  const pending = await seed(ctx.store, USER_A, "waiting", { text: "hold", pending: true });
  const refused = await call(ctx, "conversation_archive", { sessionId: pending }, { approved: true });
  assert.match(refused.output, /waiting for approval/);
  assert.equal(ctx.store.sessions.get(pending).status, "PENDING_APPROVAL");

  const archived = await call(ctx, "conversation_archive", { sessionId: "mine" }, { approved: true });
  assert.equal(archived.isError, false);
  assert.equal(ctx.store.sessions.get("mine").status, "ARCHIVED");
  const loaded = await ctx.store.load(USER_A, "mine");
  await ctx.store.saveWithEvents(USER_A, "mine", { checkpoint: loaded.checkpoint });
  assert.equal(ctx.store.sessions.get("mine").status, "ARCHIVED");
  const restored = await call(ctx, "conversation_restore", { sessionId: "mine" }, { approved: true });
  assert.equal(restored.isError, false);
  assert.equal(ctx.store.sessions.get("mine").status, "ACTIVE");
});

test("delete requires confirmation, is permanent, and keeps a fork", async () => {
  const ctx = world({
    access: new MemoryConversationAccess([[USER_A, { conversationDelete: true, conversationOrganize: true }]]),
  });
  await seed(ctx.store, USER_A, "parent", { title: "Herd", text: NOTE_A });
  const child = await ctx.store.fork(USER_A, "parent");
  const blocked = await call(ctx, "conversation_delete", { sessionId: "parent" });
  assert.match(blocked.output, /confirmation/i);
  assert.ok(ctx.store.sessions.has("parent"));
  const removed = await call(ctx, "conversation_delete", { sessionId: "parent" }, { approved: true });
  assert.equal(removed.isError, false);
  assert.equal(ctx.store.sessions.has("parent"), false);
  const kept = await ctx.store.load(USER_A, child.id);
  assert.equal(kept.forkedFromSessionId, null);
  assert.match(JSON.stringify(kept.checkpoint.transcript), new RegExp(NOTE_A));
  const again = await call(ctx, "conversation_delete", { sessionId: "parent" }, { approved: true });
  assert.equal(again.output, "session not found");
});

test("a question does not enable access or mutate a conversation", async () => {
  const ctx = world();
  await seed(ctx.store, USER_A, "mine", { title: "Herd", text: NOTE_A });
  const askedMachine = machine(ctx, [{ text: "I can't see your other conversations." }]);
  const asked = await askedMachine.run({
    userId: USER_A,
    submission: message("Can you see my other chats?", "ask"),
    toolSpecs: ctx.specs,
  });
  assert.equal(asked.status, "completed");
  assert.deepEqual(await ctx.access.get(USER_A), {
    conversationRead: false,
    conversationOrganize: false,
    conversationDelete: false,
  });
  assert.deepEqual(ctx.sessions.calls, []);
  assert.equal(ctx.store.sessions.get("mine").title, "Herd");
  assert.match(askedMachine.engine.seen[0].system, /A question about conversations is not a request/);
  assert.match(conversationGuidance(["conversation_list"]), /Organize does not allow delete/);
});

test("Claude, GPT, and Grok share the same conversation flags", async () => {
  const ctx = world({ access: new MemoryConversationAccess([[USER_A, { conversationRead: true }]]) });
  await seed(ctx.store, USER_A, "mine", { title: "Herd", text: NOTE_A });
  let sessionId = "mine";
  for (const model of ["claude", "gpt", "grok"]) {
    const selected = await machine(ctx, [{ text: model }]).run({
      userId: USER_A,
      sessionId,
      submission: { id: `model-${model}`, op: { type: "set_model", route: model } },
      toolSpecs: ctx.specs,
    });
    sessionId = selected.sessionId;
    const answer = await machine(ctx, [
      {
        parts: [
          {
            type: "tool-call",
            toolCallId: model,
            toolName: "conversation_read",
            input: { sessionId: "mine" },
          },
        ],
      },
      { text: NOTE_A },
    ]).run({
      userId: USER_A,
      sessionId,
      submission: message("Read the herd conversation", `ask-${model}`),
      toolSpecs: ctx.specs,
    });
    assert.equal(answer.status, "completed");
    assert.match(JSON.stringify(answer.checkpoint.transcript), new RegExp(NOTE_A));
    assert.equal(JSON.stringify(answer.checkpoint.transcript).includes(APPROVAL_SECRET), false);
  }
  assert.equal((await ctx.access.get(USER_A)).conversationOrganize, false);
  assert.equal((await ctx.access.get(USER_A)).conversationDelete, false);

  const web = await call(ctx, "web_search", { query: "markets" });
  assert.match(web.output, /Public markets/);
  const finance = await call(ctx, "finance_summary", {});
  assert.match(finance.output, /Module 02 read access is currently disabled/);
});

test("confirmed delete is a separate step from asking about conversations", async () => {
  const ctx = world({ access: new MemoryConversationAccess([[USER_A, { conversationDelete: true }]]) });
  await seed(ctx.store, USER_A, "mine", { text: NOTE_A });
  const turn = machine(ctx, [
    {
      parts: [
        {
          type: "tool-call",
          toolCallId: "del",
          toolName: "conversation_delete",
          input: { sessionId: "mine" },
        },
      ],
    },
    { text: "Deleted." },
  ]);
  const requested = await turn.run({
    userId: USER_A,
    submission: message("Delete the herd conversation", "del-ask"),
    toolSpecs: ctx.specs,
  });
  assert.equal(requested.status, "suspended");
  assert.ok(ctx.store.sessions.has("mine"));
  const done = await turn.run({
    userId: USER_A,
    sessionId: requested.sessionId,
    submission: approval(requested.checkpoint.pendingApproval.id),
    toolSpecs: ctx.specs,
  });
  assert.equal(done.status, "completed");
  assert.equal(ctx.store.sessions.has("mine"), false);
});

test("the signed-in user's list and history stay available without CHIEF flags", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, USER_A, "active", { title: "Freedom OS", text: NOTE_A, updatedAt: "2026-09-28T00:00:00.000Z" });
  await seed(store, USER_A, "boxed", { title: "Old", text: "boxed", updatedAt: "2026-09-29T00:00:00.000Z" });
  await store.archiveSession(USER_A, "boxed");
  await seed(store, USER_A, "nightly", {
    context: { origin: "schedule" },
    text: SCHEDULE_SECRET,
    updatedAt: "2026-09-30T00:00:00.000Z",
  });
  const auth = async () => ({ uid: USER_A });
  const listed = mockResponse();
  await handleChiefSessions(apiRequest("GET"), listed.response, { store, authenticate: auth });
  assert.deepEqual(
    listed.state.body.sessions.map((session) => session.sessionId),
    ["active"]
  );
  const archived = mockResponse();
  await handleChiefSessions(apiRequest("GET", undefined, { archived: "1" }), archived.response, {
    store,
    authenticate: auth,
  });
  assert.deepEqual(
    archived.state.body.sessions.map((session) => session.sessionId),
    ["boxed"]
  );
  const history = mockResponse();
  await handleChiefHistory(apiRequest("GET", undefined, { session_id: "active" }), history.response, {
    store,
    authenticate: auth,
  });
  assert.equal(history.state.statusCode, 200);
  assert.equal(history.state.body.messages.some((message) => message.text === NOTE_A), true);
  assert.equal(JSON.stringify(history.state.body).includes(APPROVAL_SECRET), false);
});

test("user actions share the checkpoint store and delete still requires confirm", async () => {
  const store = new MemoryCheckpointStore();
  await seed(store, USER_A, "mine", { title: "Herd", text: NOTE_A });
  await seed(store, USER_B, "theirs", { title: "Other", text: NOTE_B });
  const auth = async () => ({ uid: USER_A });
  const renamed = mockResponse();
  await handleChiefConversation(apiRequest("PATCH", { sessionId: "mine", title: "Pasture" }), renamed.response, {
    store,
    authenticate: auth,
  });
  assert.equal(renamed.state.statusCode, 200);
  assert.equal(store.sessions.get("mine").title, "Pasture");
  const stolen = mockResponse();
  await handleChiefConversation(apiRequest("PATCH", { sessionId: "theirs", title: "Stolen" }), stolen.response, {
    store,
    authenticate: auth,
  });
  assert.equal(stolen.state.statusCode, 404);
  assert.equal(store.sessions.get("theirs").title, "Other");
  const unconfirmed = mockResponse();
  await handleChiefConversation(apiRequest("DELETE", { sessionId: "mine" }), unconfirmed.response, {
    store,
    authenticate: auth,
  });
  assert.equal(unconfirmed.state.statusCode, 400);
  assert.ok(store.sessions.has("mine"));
  const removed = mockResponse();
  await handleChiefConversation(
    apiRequest("DELETE", { sessionId: "mine", confirm: true }),
    removed.response,
    { store, authenticate: auth }
  );
  assert.equal(removed.state.statusCode, 200);
  assert.equal(store.sessions.has("mine"), false);
});

test("the access API writes the same three flags and ignores other permissions", async () => {
  const store = new MemoryConversationAccess();
  const first = mockResponse();
  await handleChiefConversationAccess(apiRequest("GET"), first.response, {
    store,
    authenticate: async () => ({ uid: USER_A }),
  });
  assert.deepEqual(first.state.body, {
    conversationRead: false,
    conversationOrganize: false,
    conversationDelete: false,
  });
  const saved = mockResponse();
  await handleChiefConversationAccess(
    apiRequest("POST", { conversationRead: true, module02Read: true, userId: USER_B }),
    saved.response,
    { store, authenticate: async () => ({ uid: USER_A }) }
  );
  assert.deepEqual(saved.state.body, {
    conversationRead: true,
    conversationOrganize: false,
    conversationDelete: false,
  });
  assert.equal((await store.get(USER_B)).conversationRead, false);
});

test("prisma conversation access is scoped to the caller", async () => {
  const rows = new Map();
  const seen = [];
  const access = new PrismaConversationAccess({
    withUser: async (userId, fn) => {
      seen.push(userId);
      return fn({
        chiefConversationAccess: {
          findUnique: async ({ where }) => {
            assert.equal(where.userId, userId);
            return rows.get(userId) ?? null;
          },
          upsert: async ({ where, create }) => {
            assert.equal(where.userId, userId);
            assert.equal(create.userId, userId);
            rows.set(userId, create);
            return create;
          },
        },
      });
    },
  });
  assert.equal((await access.get(USER_A)).conversationDelete, false);
  await access.set(USER_A, { conversationDelete: true });
  assert.equal((await access.get(USER_B)).conversationDelete, false);
  assert.deepEqual(seen, [USER_A, USER_A, USER_A, USER_B]);
});

test("conversation status labels and the UI stay on the same permission record", () => {
  assert.equal(statusForToolName("conversation_list"), "Reading conversations");
  assert.equal(statusForToolName("conversation_rename"), "Updating a conversation");
  assert.equal(statusForToolName("conversation_delete"), "Deleting a conversation");
  const page = readFileSync(new URL("../src/components/chief/ChiefPage.jsx", import.meta.url), "utf8");
  const access = readFileSync(
    new URL("../src/components/chief/ChiefConversationAccess.jsx", import.meta.url),
    "utf8"
  );
  const list = readFileSync(
    new URL("../src/components/chief/ChiefConversationList.jsx", import.meta.url),
    "utf8"
  );
  assert.match(page, /ChiefConversationAccess/);
  assert.match(access, /\/api\/chief\/conversation-access/);
  assert.match(access, /conversationRead/);
  assert.match(access, /conversationOrganize/);
  assert.match(access, /conversationDelete/);
  assert.match(access, /does not allow delete/);
  assert.match(list, /Confirm delete/);
  assert.match(list, /Show archived/);
});

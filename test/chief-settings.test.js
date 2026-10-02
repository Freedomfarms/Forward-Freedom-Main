// settings_read and settings_update use the profile timezone service.
// The model cannot choose the user, the column, or a database operation.

import test from "node:test";
import assert from "node:assert/strict";

import { Effect } from "../server/chief/capabilities/descriptor.js";
import { settingsGuidance } from "../server/chief/context/assemble.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { ApprovalCoordinator } from "../server/chief/runtime/approvals.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { classifyToolCalls, TurnMachine } from "../server/chief/runtime/turn.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import { createChiefTooling, createChiefTools } from "../server/chief/tools/builtin.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import { readUserSettings, updateUserTimezone } from "../server/platform/userSettings.js";

function settingsDb(seed = {}) {
  const rows = new Map(Object.entries(seed).map(([id, row]) => [id, { id, ...row }]));
  const operations = [];
  const withUser = async (userId, fn) =>
    fn({
      user: {
        findUnique: async ({ where, select }) => {
          operations.push({ op: "findUnique", userId, whereId: where.id, select });
          const row = rows.get(where.id) ?? null;
          if (!row || !select) return row;
          const picked = {};
          for (const key of Object.keys(select)) {
            if (select[key]) picked[key] = row[key] ?? null;
          }
          return picked;
        },
        upsert: async ({ where, update, create }) => {
          operations.push({ op: "upsert", userId, whereId: where.id, update, create });
          const existing = rows.get(where.id) ?? null;
          const next = existing ? { ...existing, ...update, id: where.id } : { ...create };
          rows.set(where.id, next);
          return next;
        },
      },
    });
  return { rows, operations, withUser };
}

function policyWith(capabilities, { deny = [] } = {}) {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  for (const capability of capabilities) policy.grant("chief", capability);
  for (const capability of deny) policy.deny("chief", capability);
  return policy;
}

function toolingFor(db, capabilities, extra = {}) {
  return createChiefTooling({
    userId: "user-a",
    policy: policyWith(capabilities, extra),
    audit: new MemoryAuditLog(),
    stores: { settingsWithUser: db.withUser },
  });
}

const PRIVATE_ROW = {
  timezone: "America/Chicago",
  email: "ada@example.com",
  displayName: "Ada",
  photoURL: "https://example.com/a.png",
  role: "OWNER",
  isAdmin: true,
  legalConsentVersion: "2026-01",
  token: "secret-token",
};

test("settings capabilities are registered reads and writes", () => {
  const tools = createChiefTools({ settingsWithUser: async () => ({}) });
  const read = tools.find((tool) => tool.spec.name === "settings_read").spec;
  const update = tools.find((tool) => tool.spec.name === "settings_update").spec;
  assert.equal(read.effect, Effect.READ);
  assert.equal(read.confirmation, "none");
  assert.equal(read.requiresConfirmation, false);
  assert.equal(read.exposure, "baseline");
  assert.equal(read.subsystem, "settings");
  assert.deepEqual(read.requiredCapabilities, [Capability.SETTINGS_READ]);
  assert.equal(typeof read.execute, "undefined");
  assert.equal(update.effect, Effect.WRITE);
  assert.equal(update.confirmation, "required");
  assert.equal(update.requiresConfirmation, true);
  assert.deepEqual(update.requiredCapabilities, [Capability.SETTINGS_WRITE]);
  assert.deepEqual(CHIEF_TOOL_INVENTORY.settings_read, [Capability.SETTINGS_READ]);
  assert.deepEqual(CHIEF_TOOL_INVENTORY.settings_update, [Capability.SETTINGS_WRITE]);
  assert.equal(JSON.stringify(read).includes("secret"), false);
  assert.match(settingsGuidance(["settings_read", "settings_update"]), /settings_update/);
  assert.match(settingsGuidance(["settings_update"]), /America\/New_York/);
  assert.equal(settingsGuidance(["memory_read"]), "");
});

test("settings_read returns only the authenticated user's timezone", async () => {
  const db = settingsDb({
    "user-a": PRIVATE_ROW,
    "user-b": { ...PRIVATE_ROW, timezone: "America/Los_Angeles", email: "other@example.com" },
  });
  const tooling = await toolingFor(db, [Capability.SETTINGS_READ, Capability.SETTINGS_WRITE]);
  const result = await tooling.executor.execute(
    { callId: "r", name: "settings_read", arguments: { userId: "user-b", email: true } },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.output), { timezone: "America/Chicago" });
  assert.equal(result.output.includes("secret-token"), false);
  assert.equal(result.output.includes("ada@example.com"), false);
  assert.equal(result.output.includes("isAdmin"), false);
  assert.equal(result.output.includes("legalConsent"), false);
  assert.deepEqual(db.operations[0].select, { timezone: true });
  assert.equal(db.operations[0].userId, "user-a");
  assert.equal(db.operations[0].whereId, "user-a");
  assert.equal(
    db.operations.some((operation) => operation.whereId === "user-b"),
    false
  );
});

test("settings_read is denied without the grant and an explicit deny wins", async () => {
  const db = settingsDb({ "user-a": PRIVATE_ROW });
  const missing = await toolingFor(db, []);
  const denied = await missing.executor.execute(
    { callId: "r", name: "settings_read", arguments: {} },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(denied.isError, true);
  assert.match(denied.output, /settings:read/);
  assert.equal(db.operations.length, 0);

  const blocked = await toolingFor(db, [Capability.SETTINGS_READ], {
    deny: [Capability.SETTINGS_READ],
  });
  const explicit = await blocked.executor.execute(
    { callId: "d", name: "settings_read", arguments: { userId: "user-a" } },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(explicit.isError, true);
  assert.equal(db.operations.length, 0);
});

test("settings_update confirms, then writes only timezone for the authenticated user", async () => {
  const db = settingsDb({
    "user-a": { ...PRIVATE_ROW },
    "user-b": { timezone: "Europe/London", email: "other@example.com", isAdmin: false },
  });
  const tooling = await toolingFor(db, [Capability.SETTINGS_READ, Capability.SETTINGS_WRITE]);
  const specs = tooling.specs;
  const calls = [
    { callId: "r", name: "settings_read", arguments: {} },
    {
      callId: "w",
      name: "settings_update",
      arguments: { timezone: "America/New_York", userId: "user-b" },
    },
  ];
  const classification = classifyToolCalls(calls, specs);
  assert.deepEqual(classification, {
    mutationIds: ["w"],
    readIds: ["r"],
    explicitIds: [],
  });
  const approvals = new ApprovalCoordinator();
  approvals.sessionStart("session");
  const decision = approvals.authorize("session", calls, classification.mutationIds);
  assert.equal(decision.type, "approval");
  assert.deepEqual(decision.request.callIds, ["w"]);

  const unconfirmed = await tooling.executor.execute(
    {
      callId: "w",
      name: "settings_update",
      arguments: { timezone: "America/New_York", userId: "user-b" },
    },
    { userId: "user-a", agentId: "chief" }
  );
  assert.equal(unconfirmed.isError, true);
  assert.match(unconfirmed.output, /confirmation/);
  assert.equal(db.rows.get("user-a").timezone, "America/Chicago");
  assert.equal(db.operations.length, 0);

  const saved = await tooling.executor.execute(
    {
      callId: "w2",
      name: "settings_update",
      arguments: { timezone: "  America/New_York  ", userId: "user-b" },
    },
    { userId: "user-a", agentId: "chief", mutationApproved: true }
  );
  assert.equal(saved.isError, false);
  assert.deepEqual(JSON.parse(saved.output), { timezone: "America/New_York" });
  assert.equal(saved.output.includes("ada@example.com"), false);
  assert.equal(saved.output.includes("secret-token"), false);
  assert.equal(db.rows.get("user-a").timezone, "America/New_York");
  assert.equal(db.rows.get("user-a").email, "ada@example.com");
  assert.equal(db.rows.get("user-a").isAdmin, true);
  assert.equal(db.rows.get("user-b").timezone, "Europe/London");
  const write = db.operations.find((operation) => operation.op === "upsert");
  assert.equal(write.userId, "user-a");
  assert.equal(write.whereId, "user-a");
  assert.deepEqual(write.update, { timezone: "America/New_York" });
  assert.equal(Object.hasOwn(write.create, "email"), false);
  assert.equal(Object.hasOwn(write.create, "isAdmin"), false);
});

test("settings_update rejects invalid values, extra fields, and database operations", async () => {
  const db = settingsDb({ "user-a": { ...PRIVATE_ROW } });
  const tooling = await toolingFor(db, [Capability.SETTINGS_WRITE]);
  const context = { userId: "user-a", agentId: "chief", mutationApproved: true };
  const attempts = [
    { timezone: "Eastern" },
    { timezone: "Mars/Olympus" },
    { timezone: "" },
    { timezone: 12 },
    { timezone: "America/New_York", email: "attacker@example.com" },
    { timezone: "America/New_York", isAdmin: true },
    { timezone: "America/New_York", sql: "UPDATE \"User\" SET role = 'ADMIN'" },
    { query: 'select * from "User"' },
    { table: "User", column: "role", value: "ADMIN" },
  ];
  for (const arguments_ of attempts) {
    const result = await tooling.executor.execute(
      { callId: "bad", name: "settings_update", arguments: arguments_ },
      context
    );
    assert.equal(result.isError, true, JSON.stringify(arguments_));
  }
  assert.equal(db.rows.get("user-a").timezone, "America/Chicago");
  assert.equal(db.rows.get("user-a").email, "ada@example.com");
  assert.equal(db.rows.get("user-a").isAdmin, true);
  assert.equal(
    db.operations.some((operation) => operation.op === "upsert"),
    false
  );
});

test("a denied settings approval does not write, and an approved one does", async () => {
  const db = settingsDb({ "user-a": { timezone: "UTC", email: "ada@example.com" } });
  const store = new MemoryCheckpointStore();
  const session = await store.createSession({ userId: "user-a", context: {} });
  const tooling = await toolingFor(db, [Capability.SETTINGS_WRITE]);
  const engine = {
    steps: [
      [
        {
          type: "tool-call",
          toolCallId: "s1",
          toolName: "settings_update",
          input: { timezone: "America/Denver" },
        },
      ],
      [{ type: "text-delta", text: "Left unchanged." }],
    ],
    index: 0,
    async openStream() {
      const step = this.steps[Math.min(this.index, this.steps.length - 1)];
      this.index += 1;
      return {
        resolution: { modelKey: "scripted", caller: { kind: "user_turn" } },
        fullStream: (async function* stream() {
          for (const part of step) yield part;
        })(),
        finalize: async () => ({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          content: "",
          tool_calls: [],
          finish_reason: "stop",
        }),
      };
    },
  };
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
      op: { type: "message", message: { text: "Change my timezone to Denver." } },
    },
  });
  assert.equal(suspended.status, "suspended");
  assert.equal(db.rows.get("user-a").timezone, "UTC");
  const denied = await machine.run({
    userId: "user-a",
    sessionId: session.id,
    toolSpecs: tooling.specs,
    submission: {
      id: "sub-2",
      op: {
        type: "exec_approval",
        id: suspended.checkpoint.pendingApproval.id,
        decision: { denied: { rejection: "no" } },
      },
    },
  });
  assert.equal(denied.status, "completed");
  assert.equal(db.rows.get("user-a").timezone, "UTC");

  const approvedEngine = {
    index: 0,
    async openStream() {
      const steps = [
        [
          {
            type: "tool-call",
            toolCallId: "s2",
            toolName: "settings_update",
            input: { timezone: "America/Denver", userId: "user-b" },
          },
        ],
        [{ type: "text-delta", text: "Timezone is America/Denver." }],
      ];
      const step = steps[Math.min(this.index, steps.length - 1)];
      this.index += 1;
      return {
        resolution: { modelKey: "scripted", caller: { kind: "user_turn" } },
        fullStream: (async function* stream() {
          for (const part of step) yield part;
        })(),
        finalize: async () => ({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          content: "",
          tool_calls: [],
          finish_reason: "stop",
        }),
      };
    },
  };
  const second = new TurnMachine({
    store,
    engine: approvedEngine,
    approvals: new ApprovalCoordinator(),
    toolExecutor: tooling.executor,
  });
  const waiting = await second.run({
    userId: "user-a",
    sessionId: session.id,
    toolSpecs: tooling.specs,
    submission: {
      id: "sub-3",
      op: { type: "message", message: { text: "Set my timezone to America/Denver." } },
    },
  });
  assert.equal(waiting.status, "suspended");
  const finished = await second.run({
    userId: "user-a",
    sessionId: session.id,
    toolSpecs: tooling.specs,
    submission: {
      id: "sub-4",
      op: {
        type: "exec_approval",
        id: waiting.checkpoint.pendingApproval.id,
        decision: "approved",
      },
    },
  });
  assert.equal(finished.status, "completed");
  assert.equal(db.rows.get("user-a").timezone, "America/Denver");
  assert.equal(db.rows.get("user-a").email, "ada@example.com");
  assert.equal(db.rows.has("user-b"), false);
});

test("the settings service validates timezone and does not invent columns", async () => {
  const db = settingsDb({ "user-a": { timezone: null, email: "ada@example.com" } });
  const read = await readUserSettings("user-a", { withUser: db.withUser });
  assert.deepEqual(read, { timezone: null });
  await assert.rejects(
    () => updateUserTimezone("user-a", "Eastern", { withUser: db.withUser }),
    (error) => error.code === "INVALID_TIMEZONE"
  );
  const saved = await updateUserTimezone("user-a", "America/New_York", {
    withUser: db.withUser,
    profileColumns: { email: "ada@example.com" },
  });
  assert.equal(saved.timezone, "America/New_York");
  assert.equal(saved.email, "ada@example.com");
  const profileWrite = db.operations.find((operation) => operation.op === "upsert");
  assert.deepEqual(profileWrite.update, {
    timezone: "America/New_York",
    email: "ada@example.com",
  });
});

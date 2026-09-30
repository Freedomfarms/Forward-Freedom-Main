// Phase 7 read tools. Queries stay inside withUserContext. Results are the
// existing aggregates and workspace slice, labeled user_private.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  Capability,
  CapabilityPolicy,
  canonicalToolCapabilities,
} from "../server/chief/core/capabilities.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import { autoDetectTaint, TaintLabel } from "../server/chief/security/taint.js";
import { createChiefTools } from "../server/chief/tools/builtin.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import { BaseTool } from "../server/chief/tools/spec.js";
import {
  aggregationWindowStart,
  FINANCE_ACCOUNT_SELECT,
  FINANCE_PLAID_SELECT,
  FINANCE_TRANSACTION_SELECT,
  loadFinanceSummary,
} from "../server/finance/aggregates.js";
import { loadWorkspacePlanSummary } from "../server/finance/workspaceSlice.js";
import { encrypt, encryptJson, encryptNumber } from "../server/security/envelope.js";
import { resetKeyProviderCache } from "../server/security/keyProvider.js";

const USER_A = "user-a";
const USER_B = "user-b";
const NOW = new Date("2026-07-15T12:00:00Z");

const FORBIDDEN_OUTPUT = [
  "SECRET_MERCHANT_COFFEE_HUT",
  "SECRET_ACCOUNT_NAME",
  "SECRET_BANK_NAME",
  "plaid-secret-account-id",
  "plaid-secret-transaction-id",
  "access-token-secret",
  "ACCT-998877",
  "SHOULD_NOT_LEAK_BLOB",
  "PLAN_SECRET",
  "METRIC_SECRET",
  "buy the north pasture",
  "private farm grocery note",
  "buyer name secret",
  "OTHER_USER_BUDGET",
  "12345.67",
  "88888.01",
  "19.99",
  "999999",
];

test.before(() => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  resetKeyProviderCache();
});

function message(text, id = "sub-1") {
  return { id, op: { type: "message", message: { text } } };
}

function scripted(steps) {
  let index = 0;
  return {
    async openStream() {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      return {
        fullStream: (async function* stream() {
          for (const part of step.parts ?? []) yield part;
        })(),
        finalize: async () => ({
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          text: step.text ?? "",
        }),
      };
    },
  };
}

function project(row, select) {
  const out = {};
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = row[key];
  }
  return out;
}

function financeRows() {
  const dining = (month, day, amount, { pending = false, userId = USER_A } = {}) => ({
    id: crypto.randomUUID(),
    userId,
    merchant: "SECRET_MERCHANT_COFFEE_HUT",
    merchantCiphertext: encrypt("SECRET_MERCHANT_COFFEE_HUT"),
    category: null,
    categoryCiphertext: encrypt("Dining"),
    amount: null,
    amountCiphertext: encryptNumber(amount),
    postedAt: new Date(`${month}-${String(day).padStart(2, "0")}T12:00:00Z`),
    pending,
    plaidTransactionId: "plaid-secret-transaction-id",
  });
  return {
    transactions: [
      dining("2026-04", 10, -100),
      dining("2026-05", 10, -300),
      dining("2026-06", 10, -200),
      dining("2026-07", 10, -250),
      dining("2026-07", 11, -150),
      {
        id: crypto.randomUUID(),
        userId: USER_A,
        merchant: "SECRET_MERCHANT_COFFEE_HUT",
        merchantCiphertext: null,
        category: "Groceries",
        categoryCiphertext: null,
        amount: -150,
        amountCiphertext: null,
        postedAt: new Date("2026-07-12T12:00:00Z"),
        pending: false,
        plaidTransactionId: null,
      },
      dining("2025-12", 10, -999),
      dining("2026-07", 13, -9999, { pending: true }),
      dining("2026-07", 14, -50000, { userId: USER_B }),
    ],
    accounts: [
      {
        id: "acct-1",
        userId: USER_A,
        name: "SECRET_ACCOUNT_NAME",
        institution: "SECRET_BANK_NAME",
        plaidAccountId: "plaid-secret-account-id",
        type: "Checking",
        balance: null,
        balanceCiphertext: encryptNumber(1000),
        metadata: { mask: "ACCT-998877" },
        metadataCiphertext: encrypt("ACCT-998877"),
      },
      {
        id: "acct-2",
        userId: USER_A,
        name: "SECRET_ACCOUNT_NAME",
        institution: "SECRET_BANK_NAME",
        type: "Checking",
        balance: 500,
        balanceCiphertext: null,
      },
      {
        id: "acct-3",
        userId: USER_A,
        name: "SECRET_ACCOUNT_NAME",
        institution: "SECRET_BANK_NAME",
        type: "Credit Card",
        balance: null,
        balanceCiphertext: encryptNumber(-250),
      },
      {
        id: "acct-b",
        userId: USER_B,
        name: "SECRET_ACCOUNT_NAME",
        type: "Checking",
        balance: 99999,
        balanceCiphertext: null,
      },
    ],
    plaidItems: [
      {
        id: "item-1",
        userId: USER_A,
        itemId: "plaid-item-secret",
        institutionName: "SECRET_BANK_NAME",
        accessTokenCiphertext: "access-token-secret",
        cursor: "cursor-secret",
        status: "CONNECTED",
        lastSyncAt: new Date("2026-07-01T00:00:00Z"),
        lastSyncError: null,
      },
      {
        id: "item-2",
        userId: USER_A,
        itemId: "plaid-item-secret-2",
        institutionName: "SECRET_BANK_NAME",
        accessTokenCiphertext: "access-token-secret",
        status: "REQUIRES_ATTENTION",
        lastSyncAt: new Date("2026-07-10T00:00:00Z"),
        lastSyncError: "SECRET_BANK_NAME down",
      },
      {
        id: "item-b",
        userId: USER_B,
        institutionName: "SECRET_BANK_NAME",
        status: "CONNECTED",
        lastSyncAt: new Date("2026-07-14T00:00:00Z"),
        lastSyncError: null,
      },
    ],
  };
}

function financeDb(rows, seen) {
  return {
    async withUser(userId, fn) {
      seen.userIds.push(userId);
      const tx = {
        transaction: {
          async findMany({ where, select }) {
            seen.transactionWhere = where;
            seen.transactionSelect = select;
            return rows.transactions
              .filter((row) => row.userId === where.userId)
              .filter((row) => where.pending !== false || row.pending === false)
              .filter(
                (row) => !where.postedAt?.gte || new Date(row.postedAt) >= new Date(where.postedAt.gte)
              )
              .map((row) => project(row, select));
          },
        },
        account: {
          async findMany({ where, select }) {
            seen.accountSelect = select;
            return rows.accounts
              .filter((row) => row.userId === where.userId)
              .map((row) => project(row, select));
          },
        },
        plaidItem: {
          async findMany({ where, select }) {
            seen.plaidSelect = select;
            return rows.plaidItems
              .filter((row) => row.userId === where.userId)
              .map((row) => project(row, select));
          },
        },
      };
      return fn(tx);
    },
  };
}

function workspaceState() {
  const budgetRows = Array.from({ length: 41 }, (_, index) => ({
    name: `Category ${index}`,
    budget: 12345.67,
    description: "private farm grocery note",
  }));
  budgetRows.push({ name: "x".repeat(81), budget: 12345.67, description: "private farm grocery note" });
  return {
    activeUserId: "profile-1",
    rawDump: "SHOULD_NOT_LEAK_BLOB",
    users: [
      {
        id: "profile-1",
        budgetRows,
        incomeStreams: [
          { name: "Farm sales", amount: 88888.01, description: "buyer name secret" },
        ],
        subscriptions: [{ name: "Netflix", amount: 19.99 }],
        objectives: [{ text: "buy the north pasture" }, { text: "second objective" }],
        plansByYear: { 2026: { note: "PLAN_SECRET" }, 2025: {} },
        accounts: [
          { name: "Manual checking", accountNumber: "ACCT-998877", syncSource: "manual" },
          {
            name: "SECRET_BANK_NAME",
            plaidAccountId: "plaid-secret-account-id",
            syncSource: "Plaid",
            accessToken: "access-token-secret",
          },
        ],
        transactions: [
          {
            merchant: "SECRET_MERCHANT_COFFEE_HUT",
            amount: -50,
            source: "plaid",
            plaidTransactionId: "plaid-secret-transaction-id",
          },
        ],
        metricSnapshots: [
          {
            trueCash: 10,
            liquidCash: 20,
            creditCardDebt: 3,
            reserves: 4,
            capturedAt: "2026-07-01",
            asOf: "2026-07-01",
            totalNetWorth: 999999,
            secretField: "METRIC_SECRET",
            nested: { trueCash: 1 },
          },
        ],
      },
    ],
  };
}

function workspaceDb(snapshots, seen, { encryptionColumns = true } = {}) {
  return {
    async withUser(userId, fn) {
      seen.userIds.push(userId);
      const tx = {
        workspaceSnapshot: {
          async findUnique({ where, select }) {
            seen.where = where;
            seen.select = select ?? null;
            const row = snapshots.find((item) => item.userId === where.userId) ?? null;
            if (!row || !select) return row;
            return project(row, select);
          },
        },
      };
      return fn(tx);
    },
    async getCapabilities() {
      return { encryptionColumns };
    },
  };
}

function assertNoForbidden(value) {
  const serialized = JSON.stringify(value);
  for (const secret of FORBIDDEN_OUTPUT) {
    assert.equal(serialized.includes(secret), false, `output contains ${secret}`);
  }
}

function financePolicy() {
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("chief", Capability.FINANCE_READ);
  return policy;
}

function financeTools(seen) {
  const db = financeDb(financeRows(), seen);
  return createChiefTools({
    loadFinance: (userId) => loadFinanceSummary(userId, { now: NOW, withUser: db.withUser }),
    loadWorkspace: async () => ({ status: "available", hasSnapshot: false }),
  });
}

test("finance_summary is user-scoped, aggregated, and free of forbidden fields", async () => {
  const seen = { userIds: [] };
  const summary = await loadFinanceSummary(USER_A, {
    now: NOW,
    withUser: financeDb(financeRows(), seen).withUser,
  });

  assert.deepEqual(seen.userIds, [USER_A]);
  assert.equal(seen.transactionWhere.userId, USER_A);
  assert.equal(seen.transactionWhere.pending, false);
  assert.equal(seen.transactionWhere.postedAt.gte.getTime(), aggregationWindowStart(NOW).getTime());
  assert.deepEqual(seen.transactionSelect, FINANCE_TRANSACTION_SELECT);
  assert.deepEqual(seen.accountSelect, FINANCE_ACCOUNT_SELECT);
  assert.deepEqual(seen.plaidSelect, FINANCE_PLAID_SELECT);

  assert.deepEqual(summary.months, ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);
  assert.equal(summary.transactionCount, 6);
  const julyDining = summary.monthlyCategoryTotals.find(
    (entry) => entry.month === "2026-07" && entry.category === "Dining"
  );
  assert.equal(julyDining.total, -400);
  const julyGroceries = summary.monthlyCategoryTotals.find(
    (entry) => entry.month === "2026-07" && entry.category === "Groceries"
  );
  assert.equal(julyGroceries.total, -150);
  const diningDelta = summary.categoryDeltas.find((entry) => entry.category === "Dining");
  assert.equal(diningDelta.latestTotal, -400);
  assert.equal(diningDelta.previousTotal, -200);
  assert.equal(diningDelta.momChangePct, 100);
  assert.deepEqual(summary.accountBalancesByType, [
    { accountType: "Checking", totalBalance: 1500, accountCount: 2 },
    { accountType: "Credit Card", totalBalance: -250, accountCount: 1 },
  ]);
  assert.deepEqual(summary.plaid, {
    itemCount: 2,
    connectedCount: 1,
    requiresAttentionCount: 1,
    lastSyncAt: "2026-07-10T00:00:00.000Z",
  });
  assertNoForbidden(summary);
  assert.equal(Object.hasOwn(summary, "transactions"), false);
  assert.equal(Object.hasOwn(summary.plaid, "lastSyncError"), false);
});

test("finance_summary requires finance:read, labels user_private, and needs no confirmation", async () => {
  const seen = { userIds: [] };
  const tools = financeTools(seen);
  const finance = tools.find((tool) => tool.spec.name === "finance_summary");
  assert.equal(finance.spec.requiresConfirmation, false);
  assert.deepEqual(finance.spec.requiredCapabilities, [Capability.FINANCE_READ]);
  assert.deepEqual(CHIEF_TOOL_INVENTORY.finance_summary, [Capability.FINANCE_READ]);

  const denied = new ToolExecutor({
    tools,
    policy: (() => {
      const policy = new CapabilityPolicy({ defaultDeny: true });
      policy.grant("chief", Capability.MEMORY_READ);
      return policy;
    })(),
    audit: new MemoryAuditLog(),
  });
  const blocked = await denied.execute(
    { callId: "f", name: "finance_summary", arguments: { userId: USER_B } },
    { userId: USER_A, caller: { kind: "schedule" } }
  );
  assert.match(blocked.output, /finance:read/);
  assert.equal(seen.userIds.length, 0);

  const allowed = new ToolExecutor({
    tools,
    policy: financePolicy(),
    audit: new MemoryAuditLog(),
  });
  const result = await allowed.execute(
    { callId: "f2", name: "finance_summary", arguments: { userId: USER_B } },
    { userId: USER_A, caller: { kind: "schedule" }, mutationApproved: false }
  );
  assert.equal(result.isError, false);
  assert.deepEqual(result.sessionTaint, [TaintLabel.USER_PRIVATE]);
  assert.deepEqual(autoDetectTaint(result.output), []);
  assert.deepEqual(seen.userIds, [USER_A]);
  assertNoForbidden(JSON.parse(result.output));
});

test("a scheduled caller can read finance_summary without suspending", async () => {
  const seen = { userIds: [] };
  const tools = financeTools(seen);
  const result = await new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine: scripted([
      {
        parts: [{ type: "tool-call", toolCallId: "f", toolName: "finance_summary", input: {} }],
      },
      { parts: [{ type: "text-delta", text: "noted" }], text: "noted" },
    ]),
    toolExecutor: new ToolExecutor({
      tools,
      policy: financePolicy(),
      audit: new MemoryAuditLog(),
    }),
    callerKind: "schedule",
  }).run({
    userId: USER_A,
    submission: message("summarize spending"),
    toolSpecs: tools.map((tool) => tool.spec),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.checkpoint.sessionTaint, [TaintLabel.USER_PRIVATE]);
  assert.deepEqual(seen.userIds, [USER_A]);
  assertNoForbidden(result.checkpoint.transcript);
});

test("workspace_plan_summary returns the sanitized slice and never the blob", async () => {
  const seen = { userIds: [] };
  const state = workspaceState();
  const snapshots = [
    {
      userId: USER_A,
      state: null,
      stateCiphertext: encryptJson(state),
      source: "client",
      updatedAt: new Date("2026-07-02T00:00:00Z"),
    },
    {
      userId: USER_B,
      state: null,
      stateCiphertext: encryptJson({
        activeUserId: "other",
        users: [{ id: "other", budgetRows: [{ name: "OTHER_USER_BUDGET", budget: 1 }] }],
      }),
      updatedAt: new Date("2026-07-03T00:00:00Z"),
    },
  ];
  const db = workspaceDb(snapshots, seen);
  const summary = await loadWorkspacePlanSummary(USER_A, {
    withUser: db.withUser,
    getCapabilities: db.getCapabilities,
  });

  assert.deepEqual(seen.userIds, [USER_A]);
  assert.equal(seen.where.userId, USER_A);
  assert.equal(summary.hasSnapshot, true);
  assert.equal(summary.updatedAt, "2026-07-02T00:00:00.000Z");
  assert.equal(summary.budgetRowCount, 42);
  assert.equal(summary.budgetCategoryLabels.length, 40);
  assert.equal(summary.budgetCategoryLabels[0], "Category 0");
  assert.equal(summary.budgetCategoryLabels.some((label) => label.length > 80), false);
  assert.equal(summary.incomeStreamCount, 1);
  assert.deepEqual(summary.incomeStreamLabels, ["Farm sales"]);
  assert.equal(summary.objectiveCount, 2);
  assert.deepEqual(summary.planYears, ["2025", "2026"]);
  assert.equal(summary.storedMetricSnapshots.count, 1);
  assert.deepEqual(summary.storedMetricSnapshots.latest.fields, {
    trueCash: 10,
    liquidCash: 20,
    creditCardDebt: 3,
    reserves: 4,
    capturedAt: "2026-07-01",
    asOf: "2026-07-01",
  });
  assert.equal(Object.hasOwn(summary, "users"), false);
  assert.equal(Object.hasOwn(summary, "state"), false);
  assert.equal(Object.hasOwn(summary, "stateCiphertext"), false);
  assertNoForbidden(summary);

  const otherSeen = { userIds: [] };
  const other = await loadWorkspacePlanSummary(USER_B, {
    withUser: workspaceDb(snapshots, otherSeen).withUser,
    getCapabilities: async () => ({ encryptionColumns: true }),
  });
  assert.equal(other.budgetCategoryLabels.includes("OTHER_USER_BUDGET"), true);
  assert.equal(JSON.stringify(summary).includes("OTHER_USER_BUDGET"), false);
});

test("workspace_plan_summary legacy plaintext still slices and drops a bad ciphertext", async () => {
  const state = workspaceState();
  const seen = { userIds: [] };
  const legacy = await loadWorkspacePlanSummary(USER_A, {
    withUser: workspaceDb(
      [{ userId: USER_A, state, stateCiphertext: encryptJson({ rawDump: "SHOULD_NOT_LEAK_BLOB" }), updatedAt: NOW }],
      seen,
      { encryptionColumns: false }
    ).withUser,
    getCapabilities: async () => ({ encryptionColumns: false }),
  });
  assert.equal(seen.select.state, true);
  assert.equal(Object.hasOwn(seen.select, "stateCiphertext"), false);
  assert.equal(legacy.budgetCategoryLabels[0], "Category 0");
  assertNoForbidden(legacy);

  const broken = await loadWorkspacePlanSummary(USER_A, {
    withUser: workspaceDb(
      [{ userId: USER_A, stateCiphertext: "not-an-envelope", updatedAt: NOW }],
      { userIds: [] }
    ).withUser,
    getCapabilities: async () => ({ encryptionColumns: true }),
  });
  assert.equal(broken.parseError, true);
  assert.equal(broken.hasSnapshot, true);
  assert.equal(JSON.stringify(broken).includes("not-an-envelope"), false);
});

test("workspace_plan_summary requires finance:read and a scheduled caller can use it", async () => {
  const state = workspaceState();
  const seen = { userIds: [] };
  const db = workspaceDb(
    [{ userId: USER_A, stateCiphertext: encryptJson(state), updatedAt: new Date("2026-07-02T00:00:00Z") }],
    seen
  );
  const tools = createChiefTools({
    loadWorkspace: (userId) =>
      loadWorkspacePlanSummary(userId, { withUser: db.withUser, getCapabilities: db.getCapabilities }),
  });
  const spec = tools.find((tool) => tool.spec.name === "workspace_plan_summary").spec;
  assert.equal(spec.requiresConfirmation, false);
  assert.deepEqual(spec.requiredCapabilities, [Capability.FINANCE_READ]);
  assert.deepEqual(CHIEF_TOOL_INVENTORY.workspace_plan_summary, [Capability.FINANCE_READ]);

  const executor = new ToolExecutor({
    tools,
    policy: financePolicy(),
    audit: new MemoryAuditLog(),
  });
  const direct = await executor.execute(
    { callId: "w", name: "workspace_plan_summary", arguments: { userId: USER_B } },
    { userId: USER_A, caller: { kind: "schedule" } }
  );
  assert.deepEqual(direct.sessionTaint, [TaintLabel.USER_PRIVATE]);
  assert.deepEqual(seen.userIds, [USER_A]);
  assertNoForbidden(direct.output);

  const result = await new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine: scripted([
      {
        parts: [
          { type: "tool-call", toolCallId: "w", toolName: "workspace_plan_summary", input: { userId: USER_B } },
        ],
      },
      { parts: [{ type: "text-delta", text: "noted" }], text: "noted" },
    ]),
    toolExecutor: executor,
    callerKind: "schedule",
  }).run({
    userId: USER_A,
    submission: message("what is the plan"),
    toolSpecs: tools.map((tool) => tool.spec),
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.checkpoint.sessionTaint, [TaintLabel.USER_PRIVATE]);
  assertNoForbidden(result.checkpoint.transcript);
});

test("an uninventoried tool still fails closed and these reads add no second runtime", () => {
  assert.deepEqual(canonicalToolCapabilities("getUserData", { inventory: CHIEF_TOOL_INVENTORY }), [
    Capability.SYSTEM_ADMIN,
  ]);
  const intruder = new BaseTool({
    isLocal: true,
    spec: {
      name: "getUserData",
      description: "unrestricted read",
      requiresConfirmation: false,
      requiredCapabilities: [],
      parameters: { type: "object", properties: {} },
    },
    async execute() {
      return { output: "leaked" };
    },
  });
  const executor = new ToolExecutor({
    tools: [intruder],
    policy: financePolicy(),
    audit: new MemoryAuditLog(),
    inventory: CHIEF_TOOL_INVENTORY,
  });
  return executor
    .execute({ callId: "g", name: "getUserData", arguments: {} }, { userId: USER_A })
    .then((result) => {
      assert.match(result.output, /system:admin/);
      assert.equal(result.output.includes("leaked"), false);
    });
});

test("finance reads do not import Module 01 or add a second executor", () => {
  const repoRoot = process.cwd();
  const files = [
    "server/finance/aggregates.js",
    "server/finance/workspaceSlice.js",
    "server/chief/tools/builtin.js",
  ];
  for (const file of files) {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(source, /server\/(agents|brain|memory|capabilities)\//, file);
    assert.doesNotMatch(source, /agent-dispatch/, file);
    assert.doesNotMatch(source, /new TurnMachine/, file);
  }
  const builtin = readFileSync(path.join(repoRoot, "server/chief/tools/builtin.js"), "utf8");
  assert.equal(builtin.split("new ToolExecutor(").length - 1, 1);
  const financeAgent = readFileSync(path.join(repoRoot, "server/agents/types/finance.js"), "utf8");
  assert.match(financeAgent, /finance\/aggregates\.js/);
  assert.doesNotMatch(financeAgent, /function computeFinanceAggregates/);
  const world = readFileSync(path.join(repoRoot, "server/brain/worldModel.js"), "utf8");
  assert.match(world, /finance\/workspaceSlice\.js/);
  assert.match(world, /finance\/aggregates\.js/);
});

// Canonical finance read: one current position, one activity reader,
// shared aggregates. Position answers survive an activity failure.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { CapabilityPolicy } from "../server/chief/core/capabilities.js";
import { MemoryCheckpointStore } from "../server/chief/runtime/checkpoint.js";
import { TurnMachine } from "../server/chief/runtime/turn.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import {
  FREEDOM_FINANCIAL_READ_DISABLED,
  MemoryModuleAccess,
} from "../server/chief/security/module-access.js";
import { createChiefTools } from "../server/chief/tools/builtin.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import { loadFinancialActivity } from "../server/finance/activity.js";
import { loadCurrentPosition } from "../server/finance/dashboardPosition.js";
import { deriveFinancialPosition } from "../src/utils/financialPosition.js";
import { encryptNumber } from "../server/security/envelope.js";
import { resetKeyProviderCache } from "../server/security/keyProvider.js";

const USER_A = "user-a";
const USER_B = "user-b";
const NOW = new Date(2026, 6, 15);

test.before(() => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  resetKeyProviderCache();
});

function portfolio() {
  return [
    { id: "checking", type: "Checking", name: "Main checking", balance: 4000 },
    { id: "savings", type: "Savings", name: "Reserve savings", balance: 2500 },
    { id: "cash", type: "Manual Cash", name: "Wallet", balance: 80 },
    { id: "card-a", type: "Credit Card", name: "Card A", balance: -600 },
    { id: "card-b", type: "Credit Card", name: "Card B", balance: -150 },
    { id: "card-c", type: "Credit Card", name: "Card C", balance: 40 },
    {
      id: "xrp",
      type: "Crypto",
      name: "XRP wallet",
      cryptoSymbol: "xrp",
      cryptoName: "XRP",
      cryptoAssetId: "ripple",
      quantity: 1500,
      lastPriceUsd: 0.5,
    },
    {
      id: "btc",
      type: "Crypto",
      name: "BTC wallet",
      cryptoSymbol: "btc",
      cryptoName: "Bitcoin",
      cryptoAssetId: "bitcoin",
      quantity: 0.25,
      lastPriceUsd: 40000,
    },
    {
      id: "home",
      type: "Real Estate",
      name: "House",
      propertyMarketValue: 400000,
      linkedLoanId: "mortgage",
      balance: 1,
    },
    {
      id: "mortgage",
      type: "Mortgages / Loans",
      name: "House mortgage",
      loanCategory: "Mortgage",
      linkedPropertyId: "home",
      balance: -250000,
    },
    {
      id: "student",
      type: "Mortgages / Loans",
      name: "Student loan",
      loanCategory: "Student Loan",
      balance: -12000,
    },
    {
      id: "auto",
      type: "Mortgages / Loans",
      name: "Auto loan",
      loanCategory: "Auto",
      balance: -8000,
    },
    {
      id: "brokerage",
      type: "Investment",
      name: "Brokerage",
      plaidSubtype: "brokerage",
      balance: 9000,
    },
    { id: "ira", type: "Retirement", name: "IRA", balance: 15000 },
    {
      id: "gold",
      type: "Precious Metals",
      name: "Gold",
      metalType: "Gold",
      metalUnit: "oz",
      quantity: 2,
      pricePerUnit: 2000,
    },
  ];
}

function holding(position, symbol) {
  return position.holdings.find((row) => row.symbol === symbol);
}

test("current position separates crypto, cards, loans, cash, and net worth", () => {
  const position = deriveFinancialPosition(portfolio(), { reservesBalance: 500 });

  assert.equal(holding(position, "XRP").quantity, 1500);
  assert.equal(holding(position, "XRP").accountId, "xrp");
  assert.equal(holding(position, "XRP").cryptoAssetId, "ripple");
  assert.equal(holding(position, "BTC").quantity, 0.25);
  assert.equal(holding(position, "BTC").accountId, "btc");
  assert.equal(position.holdings.filter((row) => row.semanticCategory === "crypto").length, 2);
  assert.equal(holding(position, "ETH"), undefined);

  assert.equal(position.position.creditCardDebt, 710);
  assert.deepEqual(position.reconciliation.creditCardDebt.accountIds.sort(), [
    "card-a",
    "card-b",
    "card-c",
  ]);

  const mortgage = position.loans.find((loan) => loan.loanCategory === "Mortgage");
  assert.equal(mortgage.amountOwed, 250000);
  assert.equal(mortgage.includedInPropertyEquity, true);
  assert.equal(mortgage.accountId, "mortgage");
  assert.deepEqual(
    position.loans.map((loan) => loan.loanCategory).sort(),
    ["Auto", "Mortgage", "Student Loan"]
  );
  assert.equal(position.totals.loanDebt, 270000);
  assert.equal(position.totals.totalDebt, 270710);
  assert.notEqual(position.totals.totalDebt, position.position.creditCardDebt);

  const home = position.accounts.find((account) => account.id === "home");
  assert.equal(home.balance, 150000);
  assert.equal(home.equityDerived, true);
  assert.equal(position.reconciliation.netWorth.accountIds.includes("home"), true);
  assert.equal(position.reconciliation.netWorth.accountIds.includes("mortgage"), false);
  assert.equal(position.position.grossTrueCash, 5870);
  assert.equal(position.position.netWorth, 5870 + 9000 + 10750 + 4000 + 150000 + 15000);

  assert.equal(position.position.liquidCash, 6580);
  assert.deepEqual(position.reconciliation.liquidCash.accountIds.sort(), [
    "cash",
    "checking",
    "savings",
  ]);
  assert.equal(position.accounts.find((account) => account.id === "brokerage").securityHoldings, false);
  assert.equal(position.accounts.find((account) => account.id === "brokerage").subtype, "brokerage");
  assert.equal(position.holdings.some((row) => row.symbol === "AAPL"), false);

  for (const bucket of [
    position.reconciliation.liquidCash,
    position.reconciliation.creditCardDebt,
    position.reconciliation.loanDebt,
    position.reconciliation.totalDebt,
    position.reconciliation.netWorth,
  ]) {
    assert.ok(bucket.accountIds.length > 0);
    for (const id of bucket.accountIds) {
      assert.ok(position.accounts.some((account) => account.id === id));
    }
  }
});

function project(row, select) {
  const out = {};
  for (const key of Object.keys(select || {})) {
    if (select[key]) out[key] = row[key];
  }
  return out;
}

function dbFor(rows, { failWorkspace = false, failPlaid = false, failLedger = false, p2022 = false } = {}) {
  const seen = { users: [], accountAttempts: 0, ledgerAttempts: 0 };
  const withUser = async (userId, fn) => {
    seen.users.push(userId);
    const tx = {
      account: {
        async findMany({ where, select }) {
          seen.accountAttempts += 1;
          if (failPlaid) throw new Error("plaid query failed");
          if (p2022 && select.balanceCiphertext) {
            const error = new Error("The column Account.balanceCiphertext does not exist in the current database");
            error.code = "P2022";
            throw error;
          }
          return rows.accounts
            .filter((row) => row.userId === where.userId)
            .filter((row) => !where.workspaceUserId || row.workspaceUserId === where.workspaceUserId)
            .map((row) => project(row, select));
        },
      },
      transaction: {
        async findMany({ where, select }) {
          seen.ledgerAttempts += 1;
          if (failLedger) throw new Error("ledger query failed");
          if (p2022 && select.amountCiphertext) {
            const error = new Error("The column Transaction.amountCiphertext does not exist");
            error.code = "P2022";
            throw error;
          }
          return (rows.transactions || [])
            .filter((row) => row.userId === where.userId)
            .map((row) => project(row, select));
        },
      },
      plaidItem: {
        async findMany() {
          return [];
        },
      },
      workspaceSnapshot: {
        async findUnique() {
          return null;
        },
      },
    };
    return fn(tx);
  };
  const loadWorkspace = async (userId) => {
    if (failWorkspace) throw new Error("workspace query failed");
    if (userId !== USER_A) {
      return {
        state: {
          activeUserId: "b",
          users: [{ id: "b", accounts: [{ id: "b-cash", type: "Checking", name: "B checking", balance: 99999 }] }],
        },
      };
    }
    return { state: rows.workspace };
  };
  return { withUser, loadWorkspace, seen };
}

test("one source can fail without dropping the other, and history does not gate position", async () => {
  const workspace = {
    activeUserId: "profile-1",
    users: [
      {
        id: "profile-1",
        accounts: [
          {
            id: "xrp",
            type: "Crypto",
            name: "XRP wallet",
            cryptoSymbol: "XRP",
            cryptoName: "XRP",
            cryptoAssetId: "ripple",
            quantity: 42,
            lastPriceUsd: 1,
          },
        ],
      },
    ],
  };
  const accounts = [
    {
      id: "row-1",
      userId: USER_A,
      workspaceUserId: "profile-1",
      name: "Linked Card",
      type: "Credit Card",
      balance: -80,
      balanceCiphertext: null,
      plaidAccountId: "card-1",
      plaidSubtype: "credit card",
    },
    {
      id: "row-b",
      userId: USER_B,
      workspaceUserId: "b",
      name: "Other card",
      type: "Credit Card",
      balance: -50000,
      balanceCiphertext: null,
      plaidAccountId: "other-card",
    },
  ];

  const plaidDown = dbFor({ workspace, accounts }, { failPlaid: true });
  const fromWorkspace = await loadCurrentPosition(USER_A, {
    now: NOW,
    withUser: plaidDown.withUser,
    loadWorkspace: plaidDown.loadWorkspace,
  });
  assert.equal(fromWorkspace.sources.workspace.status, "available");
  assert.equal(fromWorkspace.sources.plaid.status, "unavailable");
  assert.equal(fromWorkspace.sources.plaid.errorClass, "query");
  assert.equal(fromWorkspace.holdings.find((row) => row.symbol === "XRP").quantity, 42);
  assert.equal(JSON.stringify(fromWorkspace).includes("50000"), false);

  const workspaceDown = dbFor({ workspace, accounts }, { failWorkspace: true });
  const fromPlaid = await loadCurrentPosition(USER_A, {
    now: NOW,
    withUser: workspaceDown.withUser,
    loadWorkspace: workspaceDown.loadWorkspace,
  });
  assert.equal(fromPlaid.sources.workspace.status, "unavailable");
  assert.equal(fromPlaid.sources.plaid.status, "available");
  assert.equal(fromPlaid.accounts.some((account) => account.id === "plaid-card-1"), true);
  assert.equal(fromPlaid.holdings.length, 0);
  assert.equal(JSON.stringify(fromPlaid).includes("50000"), false);

  const ledgerDown = dbFor({ workspace, accounts }, { failLedger: true });
  const position = await loadCurrentPosition(USER_A, {
    now: NOW,
    withUser: ledgerDown.withUser,
    loadWorkspace: ledgerDown.loadWorkspace,
  });
  assert.equal(position.sources.ledger.status, "unavailable");
  assert.notEqual(position.status, "unavailable");
  assert.equal(position.holdings.find((row) => row.symbol === "XRP").quantity, 42);
  assert.equal(position.position.creditCardDebt, 80);

  const legacy = dbFor(
    {
      workspace,
      accounts: [
        {
          id: "legacy-card",
          userId: USER_A,
          workspaceUserId: "profile-1",
          name: "Legacy card",
          type: "Credit Card",
          balance: -25,
          plaidAccountId: "legacy-card",
        },
      ],
    },
    { p2022: true }
  );
  const fallback = await loadCurrentPosition(USER_A, {
    now: NOW,
    withUser: legacy.withUser,
    loadWorkspace: legacy.loadWorkspace,
  });
  assert.equal(fallback.sources.plaid.status, "available");
  assert.equal(fallback.position.creditCardDebt, 25);
  assert.ok(legacy.seen.accountAttempts >= 2);

  const other = await loadCurrentPosition(USER_B, {
    now: NOW,
    withUser: plaidDown.withUser,
    loadWorkspace: plaidDown.loadWorkspace,
  });
  assert.equal(JSON.stringify(fromWorkspace).includes("B checking"), false);
  assert.equal(other.accounts.some((account) => account.name === "B checking"), true);
  assert.equal(other.holdings.some((row) => row.symbol === "XRP"), false);
});

test("a ciphertext decrypt failure does not invent a zero balance", async () => {
  const workspace = { activeUserId: "profile-1", users: [{ id: "profile-1", accounts: [] }] };
  const broken = dbFor({
    workspace,
    accounts: [
      {
        id: "bad",
        userId: USER_A,
        workspaceUserId: "profile-1",
        name: "Broken card",
        type: "Credit Card",
        balance: null,
        balanceCiphertext: "not-an-envelope",
        plaidAccountId: "broken",
      },
    ],
  });
  const position = await loadCurrentPosition(USER_A, {
    now: NOW,
    withUser: broken.withUser,
    loadWorkspace: broken.loadWorkspace,
  });
  assert.equal(position.sources.plaid.status, "unavailable");
  assert.equal(position.sources.plaid.errorClass, "decrypt");
  assert.equal(position.accounts.some((account) => account.name === "Broken card"), false);
  assert.equal(position.position?.creditCardDebt || 0, 0);

  const previous = process.env.FFF_ENCRYPTION_KEYS;
  const sealed = encryptNumber(-44);
  delete process.env.FFF_ENCRYPTION_KEYS;
  resetKeyProviderCache();
  try {
    const missingKey = dbFor({
      workspace,
      accounts: [
        {
          id: "sealed",
          userId: USER_A,
          workspaceUserId: "profile-1",
          name: "Sealed card",
          type: "Credit Card",
          balance: null,
          balanceCiphertext: sealed,
          plaidAccountId: "sealed",
        },
      ],
    });
    const locked = await loadCurrentPosition(USER_A, {
      now: NOW,
      withUser: missingKey.withUser,
      loadWorkspace: missingKey.loadWorkspace,
    });
    assert.equal(locked.sources.plaid.status, "unavailable");
    assert.equal(locked.sources.plaid.errorClass, "decrypt");
    assert.equal(JSON.stringify(locked).includes("Sealed card"), false);
    assert.notEqual(locked.position?.creditCardDebt, 44);
  } finally {
    process.env.FFF_ENCRYPTION_KEYS = previous;
    resetKeyProviderCache();
  }
});

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

test("CHIEF finance_summary keeps position when activity fails and answers from the shared model", async () => {
  const derived = deriveFinancialPosition(portfolio(), { reservesBalance: 0 });
  const positionPayload = {
    status: "available",
    writeAccess: false,
    securityHoldings: false,
    ...derived,
    position: derived.position,
  };
  let activityCalls = 0;
  const tools = createChiefTools({
    moduleAccess: new MemoryModuleAccess([[USER_A, true]]),
    loadPosition: async (userId) => {
      assert.equal(userId, USER_A);
      return positionPayload;
    },
    loadFinance: async () => {
      activityCalls += 1;
      throw new Error("transaction history failed");
    },
  });
  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("chief", "finance:read");
  const executor = new ToolExecutor({
    tools,
    policy,
    audit: new MemoryAuditLog(),
    inventory: CHIEF_TOOL_INVENTORY,
  });

  const denied = await executor.execute(
    { callId: "off", name: "finance_summary", arguments: {} },
    { userId: USER_B }
  );
  assert.equal(denied.output, FREEDOM_FINANCIAL_READ_DISABLED);

  const result = await new TurnMachine({
    store: new MemoryCheckpointStore(),
    engine: scripted([
      {
        parts: [{ type: "tool-call", toolCallId: "f", toolName: "finance_summary", input: {} }],
      },
      { text: "answered from position" },
    ]),
    toolExecutor: executor,
  }).run({
    userId: USER_A,
    submission: { id: "s", op: { type: "message", message: { text: "How much XRP do I own?" } } },
    toolSpecs: tools.map((tool) => tool.spec),
  });

  assert.equal(result.status, "completed");
  assert.equal(activityCalls, 1);
  const toolText = JSON.stringify(result.checkpoint.transcript);
  const body = JSON.parse(
    result.checkpoint.transcript
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .find((part) => part.type === "tool-result")?.output?.value
  );
  assert.equal(body.position.holdings.find((row) => row.symbol === "XRP").quantity, 1500);
  assert.equal(body.position.holdings.find((row) => row.symbol === "BTC").quantity, 0.25);
  assert.equal(body.position.position.creditCardDebt, 710);
  assert.equal(body.position.loans.find((loan) => loan.loanCategory === "Mortgage").amountOwed, 250000);
  assert.equal(body.position.totals.totalDebt, 270710);
  assert.equal(body.position.position.netWorth, derived.position.netWorth);
  assert.ok(body.position.reconciliation.netWorth.accountIds.includes("checking"));
  assert.equal(body.position.accounts.find((account) => account.id === "brokerage").securityHoldings, false);
  assert.equal(body.activity.status, "unavailable");
  assert.equal(body.writeAccess, false);
  assert.equal(toolText.includes("transaction history failed"), false);

  const spending = await executor.execute(
    { callId: "spend", name: "finance_summary", arguments: {} },
    { userId: USER_A }
  );
  const spent = JSON.parse(spending.output);
  assert.equal(Object.hasOwn(spent.position, "monthlyCategoryTotals"), false);
  assert.equal(spent.activity.status, "unavailable");
});

test("historical spending is read from activity, not from the position snapshot", async () => {
  const rows = {
    transactions: [
      {
        userId: USER_A,
        category: "Restaurants",
        categoryCiphertext: null,
        amount: -48,
        amountCiphertext: null,
        postedAt: new Date("2026-07-03T12:00:00Z"),
        pending: false,
      },
    ],
    accounts: [],
    plaidItems: [],
  };
  const activity = await loadFinancialActivity(USER_A, {
    now: NOW,
    withUser: async (userId, fn) => {
      assert.equal(userId, USER_A);
      return fn({
        transaction: {
          async findMany({ where, select }) {
            return rows.transactions
              .filter((row) => row.userId === where.userId)
              .map((row) => project(row, select));
          },
        },
        account: { async findMany() { return []; } },
        plaidItem: { async findMany() { return []; } },
      });
    },
    loadWorkspace: async () => ({ state: null, snapshot: null }),
  });
  assert.equal(activity.status, "available");
  const restaurants = activity.monthlyCategoryTotals.find((row) => row.category === "Restaurants");
  assert.equal(restaurants.total, -48);
  assert.equal(activity.securityHoldings, false);
});

// Phase B1: Money on returns the Freedom Financial position. Money off does not.
// The position uses the dashboard calculations and stays read-only.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { assembleSystemPrompt, createContextAssembler } from "../server/chief/context/assemble.js";
import { Capability, CapabilityPolicy } from "../server/chief/core/capabilities.js";
import {
  MemoryModuleAccess,
  FREEDOM_FINANCIAL_READ_DISABLED,
} from "../server/chief/security/module-access.js";
import { MemoryAuditLog } from "../server/chief/security/audit.js";
import { createChiefTools } from "../server/chief/tools/builtin.js";
import { ToolExecutor } from "../server/chief/tools/executor.js";
import { CHIEF_TOOL_INVENTORY } from "../server/chief/tools/inventory.js";
import {
  buildDashboardPosition,
  loadFreedomFinancialPosition,
} from "../server/finance/dashboardPosition.js";
import { encrypt, encryptNumber } from "../server/security/envelope.js";
import { resetKeyProviderCache } from "../server/security/keyProvider.js";

const USER_A = "user-a";
const USER_B = "user-b";
const NOW = new Date(2026, 6, 15);

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

test.before(() => {
  process.env.FFF_ENCRYPTION_KEYS = `1:${crypto.randomBytes(32).toString("base64")}`;
  process.env.FFF_ENCRYPTION_ACTIVE_VERSION = "1";
  resetKeyProviderCache();
});

function project(row, select) {
  const out = {};
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = row[key];
  }
  return out;
}

test("the dashboard position matches Freedom Financial math and hides private fields", () => {
  const position = buildDashboardPosition({
    now: NOW,
    createdAt: null,
    plansByYear: { 2026: { startingTrueCash: 900, note: "PLAN_SECRET" } },
    budgetRows: [
      {
        name: "Groceries",
        budget: 400,
        description: "private farm grocery note",
        transactionCategories: ["Groceries"],
      },
      {
        name: "Emergency",
        type: "R",
        budget: 100,
        description: "private farm grocery note",
        reserveAnchor: { month: "Jul", year: 2026 },
      },
    ],
    incomeStreams: [{ name: "Salary", amount: 2000, description: "buyer name secret" }],
    accounts: [
      {
        type: "Checking",
        balance: 2000,
        name: "SECRET_ACCOUNT_NAME",
        institution: "SECRET_BANK_NAME",
      },
      { type: "Credit Card", balance: -500, name: "SECRET_ACCOUNT_NAME" },
      { type: "Investment", balance: 1000, name: "SECRET_ACCOUNT_NAME" },
      { type: "Crypto", quantity: 2, lastPriceUsd: 50, balance: 1, name: "SECRET_ACCOUNT_NAME" },
      {
        id: "re-1",
        type: "Real Estate",
        balance: 999,
        propertyMarketValue: 800,
        linkedLoanId: "loan-1",
        name: "SECRET_ACCOUNT_NAME",
        propertyAddress: "123 Secret Lane",
      },
      { id: "loan-1", type: "Mortgages / Loans", balance: -300, name: "SECRET_ACCOUNT_NAME" },
    ],
    transactions: [
      {
        date: "July 10, 2026",
        amount: -120,
        category: "Groceries",
        merchant: "SECRET_MERCHANT_COFFEE_HUT",
        account: "SECRET_ACCOUNT_NAME",
      },
    ],
  });

  assert.deepEqual(position.position, {
    liquidCash: 2000,
    creditCardDebt: 500,
    reservesBalance: 100,
    reservesOvercommitted: false,
    grossTrueCash: 1500,
    trueCash: 1400,
    netWorth: 3100,
  });
  assert.deepEqual(
    position.allocation.map((slice) => [slice.name, slice.amount, slice.share]),
    [
      ["True Cash", 1500, 48.4],
      ["Investments", 1000, 32.3],
      ["Crypto", 100, 3.2],
      ["Precious Metals", 0, 0],
      ["Real Estate", 500, 16.1],
      ["Retirement", 0, 0],
    ]
  );
  assert.equal(position.currentMonth.income, 2000);
  assert.equal(position.currentMonth.budget, 500);
  assert.equal(position.currentMonth.plannedFlow, 1500);
  assert.equal(position.currentMonth.spent, 120);
  assert.equal(position.currentMonth.remaining, 380);
  const groceries = position.currentMonth.byCategory.find((row) => row.category === "Groceries");
  assert.deepEqual(groceries, {
    category: "Groceries",
    kind: "operating",
    budget: 400,
    spent: 120,
    remaining: 280,
  });
  assert.equal(position.reserves.totalBalance, 100);
  assert.equal(position.yearlyOutlook.startingTrueCash, 900);
  assert.equal(position.yearlyOutlook.startingMonth, "Jul");
  assert.equal(
    position.yearlyOutlook.projectedTrueCash.find((point) => point.month === "Jun").value,
    null
  );
  assert.equal(
    position.yearlyOutlook.projectedTrueCash.find((point) => point.month === "Jul").value,
    2400
  );
  assert.equal(position.yearlyOutlook.months.find((month) => month.month === "Jul").spent, 120);

  const serialized = JSON.stringify(position);
  for (const secret of [
    "PLAN_SECRET",
    "private farm grocery note",
    "buyer name secret",
    "SECRET_ACCOUNT_NAME",
    "SECRET_BANK_NAME",
    "SECRET_MERCHANT_COFFEE_HUT",
    "123 Secret Lane",
    "loan-1",
    "re-1",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(Object.hasOwn(position, "transactions"), false);
  assert.deepEqual(position.holdings, []);
});

test("holdings keep crypto and metal identity and drop account names", () => {
  const position = buildDashboardPosition({
    now: NOW,
    accounts: [
      {
        type: "Crypto",
        cryptoSymbol: "xrp",
        cryptoName: "XRP",
        quantity: 120,
        lastPriceUsd: 0.5,
        balance: 1,
        name: "SECRET_ACCOUNT_NAME",
        institution: "SECRET_BANK_NAME",
        cryptoAssetId: "ripple-secret",
        cryptoThumb: "https://secret.example/thumb",
      },
      {
        type: "Precious Metals",
        metalType: "Gold",
        metalUnit: "oz",
        quantity: 3,
        pricePerUnit: 2000,
        metalCustomName: "SECRET_ACCOUNT_NAME",
        name: "SECRET_ACCOUNT_NAME",
      },
      {
        type: "Precious Metals",
        metalType: "Custom",
        metalCustomName: "SECRET_ACCOUNT_NAME",
        quantity: 1,
        pricePerUnit: 10,
      },
      { type: "Checking", balance: 10, name: "SECRET_ACCOUNT_NAME" },
    ],
  });
  assert.equal(position.allocation.find((slice) => slice.name === "Crypto").amount, 60);
  assert.deepEqual(position.holdings, [
    {
      type: "Crypto",
      symbol: "XRP",
      asset: "XRP",
      quantity: 120,
      unit: "XRP",
      balance: 60,
    },
    {
      type: "Precious Metals",
      metal: "Gold",
      quantity: 3,
      unit: "oz",
      balance: 6000,
    },
  ]);
  const serialized = JSON.stringify(position);
  assert.equal(serialized.includes("SECRET_ACCOUNT_NAME"), false);
  assert.equal(serialized.includes("SECRET_BANK_NAME"), false);
  assert.equal(serialized.includes("ripple-secret"), false);
  assert.equal(serialized.includes("secret.example"), false);
});

test("a positive credit card balance reduces debt and an empty portfolio is not worth one dollar", () => {
  const cards = buildDashboardPosition({
    now: NOW,
    accounts: [
      { type: "Credit Card", balance: -200 },
      { type: "Credit Card", balance: 50 },
    ],
  });
  assert.equal(cards.position.creditCardDebt, 150);
  assert.equal(cards.position.trueCash, -150);

  const empty = buildDashboardPosition({ now: NOW });
  assert.equal(empty.position.netWorth, 0);
  assert.ok(empty.allocation.every((slice) => slice.share === null));

  const overcommitted = buildDashboardPosition({
    now: NOW,
    accounts: [{ type: "Checking", balance: 50 }],
    budgetRows: [
      { name: "Emergency", type: "R", budget: 200, reserveAnchor: { month: "Jul", year: 2026 } },
    ],
  });
  assert.equal(overcommitted.position.reservesBalance, 200);
  assert.equal(overcommitted.position.trueCash, -150);
  assert.equal(overcommitted.position.reservesOvercommitted, true);
});

test("the position loader is user-scoped, profile-scoped, and free of secrets", async () => {
  const seen = {};
  const rows = {
    accounts: [
      {
        userId: USER_A,
        workspaceUserId: "profile-1",
        type: "Checking",
        name: "SECRET_ACCOUNT_NAME",
        institution: "SECRET_BANK_NAME",
        balance: null,
        balanceCiphertext: encryptNumber(300),
        plaidAccountId: "plaid-secret-account-id",
      },
      {
        userId: USER_A,
        workspaceUserId: "profile-2",
        type: "Checking",
        balance: 777,
        balanceCiphertext: null,
        name: "SECRET_ACCOUNT_NAME",
      },
      {
        userId: USER_B,
        workspaceUserId: "other",
        type: "Checking",
        balance: 99999,
        balanceCiphertext: null,
        name: "SECRET_ACCOUNT_NAME",
      },
    ],
    transactions: [
      {
        userId: USER_A,
        workspaceUserId: "profile-1",
        merchant: "SECRET_MERCHANT_COFFEE_HUT",
        merchantCiphertext: encrypt("SECRET_MERCHANT_COFFEE_HUT"),
        category: null,
        categoryCiphertext: encrypt("Dining"),
        amount: null,
        amountCiphertext: encryptNumber(-40),
        postedAt: new Date("2026-07-10T12:00:00Z"),
        pending: false,
        plaidTransactionId: "plaid-secret-transaction-id",
      },
      {
        userId: USER_B,
        workspaceUserId: "other",
        category: "Rent",
        categoryCiphertext: null,
        amount: -50000,
        amountCiphertext: null,
        postedAt: new Date("2026-07-10T12:00:00Z"),
        pending: false,
        merchant: "SECRET_MERCHANT_COFFEE_HUT",
      },
    ],
  };

  const withUser = async (userId, fn) =>
    fn({
      account: {
        async findMany({ where, select }) {
          seen.accountSelect = select;
          return rows.accounts
            .filter((row) => row.userId === where.userId)
            .map((row) => project(row, select));
        },
      },
      transaction: {
        async findMany({ where, select }) {
          seen.transactionSelect = select;
          return rows.transactions
            .filter((row) => row.userId === where.userId)
            .filter((row) => where.pending !== false || row.pending === false)
            .map((row) => project(row, select));
        },
      },
    });

  const loadWorkspace = async (userId) => {
    if (userId !== USER_A) {
      return {
        state: {
          activeUserId: "other",
          users: [{ id: "other", accounts: [{ type: "Savings", balance: 5 }] }],
        },
      };
    }
    return {
      state: {
        activeUserId: "profile-1",
        rawDump: "SHOULD_NOT_LEAK_BLOB",
        users: [
          {
            id: "profile-1",
            accounts: [
              {
                type: "Checking",
                balance: 2000,
                name: "SECRET_ACCOUNT_NAME",
                institution: "SECRET_BANK_NAME",
                accountNumber: "ACCT-998877",
              },
            ],
            transactions: [
              {
                date: "July 4, 2026",
                amount: -15,
                category: "Dining",
                merchant: "SECRET_MERCHANT_COFFEE_HUT",
              },
            ],
            budgetRows: [{ name: "Dining", budget: 80, description: "private farm grocery note" }],
            incomeStreams: [{ name: "Salary", amount: 1000, description: "buyer name secret" }],
            plansByYear: { 2026: { note: "PLAN_SECRET" } },
          },
          {
            id: "profile-2",
            accounts: [{ type: "Checking", balance: 777, name: "OTHER_PROFILE" }],
          },
        ],
      },
    };
  };

  const position = await loadFreedomFinancialPosition(USER_A, {
    now: NOW,
    withUser,
    loadWorkspace,
  });
  assert.equal(position.writeAccess, false);
  assert.equal(position.position.liquidCash, 2300);
  assert.equal(position.position.creditCardDebt, 0);
  assert.equal(position.currentMonth.income, 1000);
  assert.equal(position.currentMonth.spent, 55);
  const dining = position.currentMonth.byCategory.find((row) => row.category === "Dining");
  assert.equal(dining.spent, 55);
  assert.equal(seen.accountSelect.name, undefined);
  assert.equal(seen.accountSelect.institution, undefined);
  assert.equal(seen.accountSelect.plaidAccountId, undefined);
  assert.equal(seen.transactionSelect.merchant, undefined);
  assert.equal(seen.transactionSelect.merchantCiphertext, undefined);
  assert.equal(seen.transactionSelect.plaidTransactionId, undefined);

  const serialized = JSON.stringify(position);
  for (const secret of [
    "SECRET_MERCHANT_COFFEE_HUT",
    "SECRET_ACCOUNT_NAME",
    "SECRET_BANK_NAME",
    "plaid-secret-account-id",
    "plaid-secret-transaction-id",
    "ACCT-998877",
    "SHOULD_NOT_LEAK_BLOB",
    "PLAN_SECRET",
    "private farm grocery note",
    "buyer name secret",
    "99999",
    "777",
    "OTHER_PROFILE",
    "50000",
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }

  const other = await loadFreedomFinancialPosition(USER_B, { now: NOW, withUser, loadWorkspace });
  assert.equal(other.position.liquidCash, 100004);
  assert.equal(JSON.stringify(position).includes("100004"), false);
});

test("finance_summary returns the position only for the authenticated user when Money is on", async () => {
  const loads = [];
  const positions = [];
  const access = new MemoryModuleAccess([[USER_A, true]]);
  const tools = createChiefTools({
    moduleAccess: access,
    loadFinance: async (userId) => {
      loads.push(userId);
      return { cashPosition: userId === USER_A ? "ONLY_A" : "ONLY_B" };
    },
    loadPosition: async (userId) => {
      positions.push(userId);
      return {
        status: "available",
        writeAccess: false,
        position: { trueCash: userId === USER_A ? 42 : 7 },
      };
    },
  });
  const names = tools.map((tool) => tool.spec.name);
  for (const name of WRITE_NAMES) assert.equal(names.includes(name), false);
  assert.equal(Object.hasOwn(CHIEF_TOOL_INVENTORY, "finance_write"), false);
  const finance = tools.find((tool) => tool.spec.name === "finance_summary");
  const setAccess = tools.find((tool) => tool.spec.name === "freedom_financial_access_set");
  assert.equal(finance.spec.requiresConfirmation, false);
  assert.equal(setAccess.spec.requiresConfirmation, true);
  assert.deepEqual(finance.spec.requiredCapabilities, [Capability.FINANCE_READ]);

  const policy = new CapabilityPolicy({ defaultDeny: true });
  policy.grant("chief", Capability.FINANCE_READ);
  policy.grant("chief", Capability.MODULE_ACCESS);
  const executor = new ToolExecutor({
    tools,
    policy,
    audit: new MemoryAuditLog(),
    inventory: CHIEF_TOOL_INVENTORY,
  });

  await access.setFreedomFinancialReadEnabled(USER_A, false);
  const denied = await executor.execute(
    { callId: "off", name: "finance_summary", arguments: {} },
    { userId: USER_A }
  );
  assert.equal(denied.output, FREEDOM_FINANCIAL_READ_DISABLED);
  assert.deepEqual(loads, []);
  assert.deepEqual(positions, []);

  await access.setFreedomFinancialReadEnabled(USER_A, true);
  const allowed = await executor.execute(
    { callId: "on", name: "finance_summary", arguments: { userId: USER_B } },
    { userId: USER_A }
  );
  const body = JSON.parse(allowed.output);
  assert.equal(allowed.isError, false);
  assert.equal(body.cashPosition, "ONLY_A");
  assert.equal(body.dashboard.position.trueCash, 42);
  assert.equal(body.writeAccess, false);
  assert.equal(body.dashboard.writeAccess, false);
  assert.equal(allowed.output.includes("ONLY_B"), false);
  assert.equal(allowed.output.includes('"trueCash":7'), false);
  assert.deepEqual(loads, [USER_A]);
  assert.deepEqual(positions, [USER_A]);

  const changed = await executor.execute(
    { callId: "set", name: "freedom_financial_access_set", arguments: { enabled: false } },
    { userId: USER_A, mutationApproved: true }
  );
  assert.deepEqual(JSON.parse(changed.output), {
    freedomFinancialRead: false,
    writeAccess: false,
    message: "Freedom Financial read access is off.",
  });
  assert.deepEqual(loads, [USER_A]);
});

test("system guidance follows the caller's freedomFinancialRead flag", async () => {
  const facts = {
    async read() {
      return [];
    },
  };
  const off = await assembleSystemPrompt({
    userId: USER_A,
    query: "What is my True Cash?",
    facts,
    availableTools: ["finance_summary", "freedom_financial_access_set"],
  });
  assert.match(off, /read access is off/);
  assert.match(off, /write access is not currently available/);
  assert.match(off, /is not a request to enable/);
  assert.doesNotMatch(off, /read access is on/);

  const on = await assembleSystemPrompt({
    userId: USER_A,
    query: "What is my True Cash?",
    facts,
    availableTools: ["finance_summary", "freedom_financial_access_set"],
    freedomFinancialRead: true,
  });
  assert.match(on, /read access is on/);
  assert.match(on, /write access is not currently available/);
  assert.match(on, /is not a request to enable/);
  assert.doesNotMatch(on, /read access is off/);

  const access = new MemoryModuleAccess([[USER_A, true]]);
  const assembler = createContextAssembler({ facts, moduleAccess: access });
  const prompted = await assembler({
    userId: USER_A,
    transcript: [{ role: "user", content: "What is my net worth?" }],
    availableTools: ["finance_summary"],
  });
  assert.match(prompted, /read access is on/);
  await access.setFreedomFinancialReadEnabled(USER_A, false);
  const denied = await assembler({
    userId: USER_A,
    transcript: [{ role: "user", content: "What is my net worth?" }],
    availableTools: ["finance_summary"],
  });
  assert.match(denied, /read access is off/);
  assert.doesNotMatch(denied, /read access is on/);
});

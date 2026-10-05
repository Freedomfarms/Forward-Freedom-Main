// Read-only Freedom Financial position for CHIEF.
//
// Uses the dashboard's own calculations (True Cash, reserves, monthly spend,
// yearly plan). The result is a projection: account names, merchants,
// institutions, tokens, and raw transactions are never copied into it.
// Holdings keep the asset symbol or metal, quantity, and balance the
// dashboard already shows.

import { withUserContext } from "../db/prisma.js";
import { decrypt as decryptField, decryptNumber } from "../security/envelope.js";
import {
  calculatePreciousMetalsBalance,
  calculateRealEstateEquity,
} from "../../src/utils/accounts.js";
import { calculateCryptoBalance } from "../../src/utils/cryptoPricing.js";
import { buildMonthlySpendSnapshot } from "../../src/utils/budgetReview.js";
import {
  budgetMonthNames,
  budgetMonths,
  BUDGET_CATEGORY_TYPES,
} from "../../src/utils/budgetModel.js";
import { getBudgetPeriodAtOffset, getCurrentBudgetPeriod } from "../../src/utils/date.js";
import { parseMoney } from "../../src/utils/format.js";
import { addMoney, roundMoney, subtractMoney, sumMoney } from "../../src/utils/money.js";
import { buildPlanYearData, buildProjectedTrueCashSeries } from "../../src/utils/planning.js";
import { buildReserveReadiness, computeTrueCash, isReserveRow } from "../../src/utils/reserves.js";
import { buildYearlyPlanningMetrics } from "../../src/utils/yearlyPlanningMetrics.js";
import { loadSanitizedWorkspaceState } from "./workspaceSlice.js";

const LIQUID_ACCOUNT_TYPES = new Set(["Checking", "Savings", "Manual Cash"]);
const LABEL_MAX_CHARS = 80;
const CATEGORY_MAX_ENTRIES = 80;
const KNOWN_METALS = new Set(["Gold", "Silver", "Platinum", "Palladium"]);
const METAL_UNITS = new Set(["oz", "ozt", "g", "kg", "lb"]);
const HOLDING_SYMBOL = /^[A-Za-z0-9]{1,12}$/;
const HOLDING_ASSET = /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,40}$/;

const POSITION_ACCOUNT_SELECT = Object.freeze({
  type: true,
  balance: true,
  balanceCiphertext: true,
  workspaceUserId: true,
});

const POSITION_TRANSACTION_SELECT = Object.freeze({
  category: true,
  categoryCiphertext: true,
  amount: true,
  amountCiphertext: true,
  postedAt: true,
  workspaceUserId: true,
});

const ALLOCATION_TYPES = [
  ["Investments", "Investment"],
  ["Crypto", "Crypto"],
  ["Precious Metals", "Precious Metals"],
  ["Real Estate", "Real Estate"],
  ["Retirement", "Retirement"],
];

function labelOf(value) {
  const text = String(value || "").trim();
  if (!text || text.length > LABEL_MAX_CHARS) return "";
  return text;
}

function formatBudgetDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shareOf(amount, netWorth) {
  if (!(netWorth > 0)) return null;
  return Math.round((amount / netWorth) * 1000) / 10;
}

function sumType(accounts, type) {
  return sumMoney(
    accounts.filter((account) => account.type === type),
    (account) => account.balance
  );
}

// Same anchor the dashboard uses for the plan year: profile creation, else the
// earliest stored metric date, else the current month.
function anchorStartingMonth(profile, fallbackMonth) {
  const createdAt = typeof profile?.createdAt === "string" ? new Date(profile.createdAt) : null;
  if (createdAt && !Number.isNaN(createdAt.getTime())) {
    return getBudgetPeriodAtOffset(0, createdAt).month;
  }
  const snapshots = profile?.metricSnapshots;
  const keys = snapshots && typeof snapshots === "object" ? Object.keys(snapshots) : [];
  const earliest = keys
    .map((dateKey) => {
      const [year, month, day] = String(dateKey).split("-").map(Number);
      if (!year || !month || !day) return null;
      return new Date(year, month - 1, day);
    })
    .filter((date) => date && !Number.isNaN(date.getTime()))
    .sort((left, right) => left - right)[0];
  if (earliest) return getBudgetPeriodAtOffset(0, earliest).month;
  return fallbackMonth;
}

function derivedAccounts(accounts) {
  const prepared = (Array.isArray(accounts) ? accounts : []).map((account, index) => {
    const type = typeof account?.type === "string" && account.type ? account.type : "Checking";
    let balance = roundMoney(account?.balance);
    if (type === "Crypto" && (account?.quantity != null || account?.lastPriceUsd != null)) {
      balance = calculateCryptoBalance(account.quantity, account.lastPriceUsd);
    }
    if (
      type === "Precious Metals" &&
      (account?.quantity != null || account?.pricePerUnit != null)
    ) {
      balance = calculatePreciousMetalsBalance(account.quantity, account.pricePerUnit);
    }
    return {
      id: typeof account?.id === "string" && account.id ? account.id : `acct-${index}`,
      type,
      balance,
      linkedLoanId: typeof account?.linkedLoanId === "string" ? account.linkedLoanId : "",
      propertyMarketValue: roundMoney(account?.propertyMarketValue),
    };
  });

  return prepared.map((account) => {
    if (account.type !== "Real Estate") return account;
    if (!account.linkedLoanId || !account.propertyMarketValue) return account;
    const linkedLoan = prepared.find((candidate) => candidate.id === account.linkedLoanId);
    if (!linkedLoan) return account;
    return {
      ...account,
      balance: calculateRealEstateEquity(account.propertyMarketValue, linkedLoan.balance),
    };
  });
}

function safeTransactions(transactions) {
  return (Array.isArray(transactions) ? transactions : []).map((transaction) => ({
    amount: transaction?.amount,
    category: typeof transaction?.category === "string" ? transaction.category : "",
    date: typeof transaction?.date === "string" ? transaction.date : "",
  }));
}

function finiteQuantity(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function holdingRow(source, derived) {
  if (derived?.type === "Crypto") {
    const rawSymbol = typeof source?.cryptoSymbol === "string" ? source.cryptoSymbol.trim() : "";
    const symbol = HOLDING_SYMBOL.test(rawSymbol) ? rawSymbol.toUpperCase() : "";
    const rawAsset = typeof source?.cryptoName === "string" ? source.cryptoName.trim() : "";
    const asset = HOLDING_ASSET.test(rawAsset) ? rawAsset : "";
    if (!symbol && !asset) return null;
    return {
      type: "Crypto",
      symbol,
      asset,
      quantity: finiteQuantity(source?.quantity),
      unit: symbol || "units",
      balance: derived.balance,
    };
  }
  if (derived?.type === "Precious Metals") {
    const metal = typeof source?.metalType === "string" ? source.metalType.trim() : "";
    if (!KNOWN_METALS.has(metal)) return null;
    const unit = typeof source?.metalUnit === "string" ? source.metalUnit.trim() : "";
    return {
      type: "Precious Metals",
      metal,
      quantity: finiteQuantity(source?.quantity),
      unit: METAL_UNITS.has(unit) ? unit : "oz",
      balance: derived.balance,
    };
  }
  return null;
}

function holdingsOf(accounts, synced) {
  const source = Array.isArray(accounts) ? accounts : [];
  const rows = [];
  for (let index = 0; index < synced.length; index += 1) {
    const row = holdingRow(source[index], synced[index]);
    if (!row) continue;
    rows.push(row);
    if (rows.length >= CATEGORY_MAX_ENTRIES) break;
  }
  return rows;
}

function balancesByType(accounts) {
  const totals = new Map();
  for (const account of accounts) {
    const existing = totals.get(account.type) || { totalBalance: 0, accountCount: 0 };
    existing.totalBalance = addMoney(existing.totalBalance, account.balance);
    existing.accountCount += 1;
    totals.set(account.type, existing);
  }
  return [...totals.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([accountType, entry]) => ({
      accountType,
      totalBalance: entry.totalBalance,
      accountCount: entry.accountCount,
    }));
}

function categoryRows(snapshot) {
  const rows = (snapshot.rows || [])
    .map((row) => {
      const category = labelOf(row?.name || row?.category || row?.label);
      if (!category) return null;
      return {
        category,
        kind: row?.type === BUDGET_CATEGORY_TYPES.RESERVE ? "reserve" : "operating",
        budget: roundMoney(row.budget),
        spent: roundMoney(row.spent),
        remaining: roundMoney(row.remaining),
      };
    })
    .filter(Boolean);
  return {
    rows: rows.slice(0, CATEGORY_MAX_ENTRIES),
    categoryCount: rows.length,
    truncated: rows.length > CATEGORY_MAX_ENTRIES,
  };
}

function reserveFunds(readiness) {
  return (readiness.reserves || [])
    .map((reserve) => {
      const name = labelOf(reserve?.name);
      if (!name) return null;
      return {
        name,
        balance: roundMoney(reserve.balance),
        target: roundMoney(reserve.target),
        monthlyContribution: roundMoney(reserve.monthlyContribution),
        readinessPercent: reserve.readinessPercent,
        status: reserve.status?.label || "",
      };
    })
    .filter(Boolean)
    .slice(0, CATEGORY_MAX_ENTRIES);
}

function incomeRows(incomeStreams, month) {
  return (Array.isArray(incomeStreams) ? incomeStreams : [])
    .map((stream) => {
      const label = labelOf(stream?.name || stream?.label);
      if (!label) return null;
      return {
        label,
        amount: parseMoney(stream.amount),
        activeThisMonth: (stream.months || budgetMonths).includes(month),
      };
    })
    .filter(Boolean)
    .slice(0, CATEGORY_MAX_ENTRIES);
}

export function activeWorkspaceUser(state) {
  if (!state || typeof state !== "object") return null;
  const users = Array.isArray(state.users) ? state.users : [];
  return users.find((user) => user?.id && user.id === state.activeUserId) || users[0] || null;
}

/**
 * Pure dashboard position. Dollar totals use type and balance. Holdings also
 * read crypto symbol, crypto name, metal, quantity, and unit. Account names,
 * institutions, addresses, and identifiers are not copied.
 */
export function buildDashboardPosition({
  accounts = [],
  transactions = [],
  budgetRows = [],
  incomeStreams = [],
  plansByYear = {},
  createdAt = null,
  metricSnapshots = null,
  now = new Date(),
} = {}) {
  const period = getCurrentBudgetPeriod(now);
  const syncedAccounts = derivedAccounts(accounts);
  const ledger = safeTransactions(transactions);
  const rows = Array.isArray(budgetRows) ? budgetRows : [];
  const streams = Array.isArray(incomeStreams) ? incomeStreams : [];
  const plans = plansByYear && typeof plansByYear === "object" ? plansByYear : {};

  const liquidCash = sumMoney(
    syncedAccounts.filter((account) => LIQUID_ACCOUNT_TYPES.has(account.type)),
    (account) => account.balance
  );
  const creditCardNetBalance = sumType(syncedAccounts, "Credit Card");
  const creditCardDebt = Math.max(0, -creditCardNetBalance);
  const reserveReadiness = buildReserveReadiness(rows.filter(isReserveRow), ledger, {
    asOfMonth: period.month,
    asOfYear: period.year,
  });
  const reservesBalance = reserveReadiness.totalBalance;
  const grossTrueCash = subtractMoney(liquidCash, creditCardDebt);
  const trueCash = computeTrueCash({ liquidCash, creditCardDebt, reservesBalance });

  const allocationAmounts = ALLOCATION_TYPES.map(([name, type]) => ({
    name,
    amount: sumType(syncedAccounts, type),
  }));
  const netWorth = addMoney(grossTrueCash, ...allocationAmounts.map((slice) => slice.amount));
  const allocation = [
    { name: "True Cash", amount: grossTrueCash, share: shareOf(grossTrueCash, netWorth) },
    ...allocationAmounts.map((slice) => ({
      name: slice.name,
      amount: slice.amount,
      share: shareOf(slice.amount, netWorth),
    })),
  ];

  const spend = buildMonthlySpendSnapshot(ledger, rows, {
    month: period.month,
    year: period.year,
  });
  const categories = categoryRows(spend);
  const currentMonthIncome = sumMoney(
    streams.filter((stream) => (stream.months || budgetMonths).includes(period.month)),
    (stream) => parseMoney(stream.amount)
  );
  const currentMonthBudget = sumMoney(
    rows.filter((row) => (row.months || budgetMonths).includes(period.month)),
    (row) => row.budget
  );

  const yearPlan = plans[String(period.year)] || null;
  const startingTrueCash =
    yearPlan?.startingTrueCash && yearPlan.startingTrueCash !== 0
      ? yearPlan.startingTrueCash
      : trueCash;
  const startingMonth = anchorStartingMonth({ createdAt, metricSnapshots }, period.month);
  const planData = buildPlanYearData({
    budgetRows: rows,
    incomeStreams: streams,
    startingMonth,
    startingTrueCash,
  });
  const yearly = buildYearlyPlanningMetrics({
    transactions: ledger,
    budgetRows: rows,
    incomeStreams: streams,
    yearlyOpsSeed: [],
    useSeedFallback: false,
    year: period.year,
  });
  const projected = buildProjectedTrueCashSeries({
    targetYear: period.year,
    incomeStreams: planData.incomeStreams,
    budgetRows: planData.budgetRows,
    startingMonth: planData.startingMonth,
    startingTrueCash: planData.startingTrueCash,
  });

  return {
    asOf: {
      month: period.month,
      year: period.year,
      label: `${budgetMonthNames[period.month]} ${period.year}`,
    },
    position: {
      liquidCash,
      creditCardDebt,
      reservesBalance,
      reservesOvercommitted: reservesBalance > liquidCash,
      grossTrueCash,
      trueCash,
      netWorth,
    },
    allocation,
    holdings: holdingsOf(accounts, syncedAccounts),
    balancesByType: balancesByType(syncedAccounts),
    currentMonth: {
      month: period.month,
      year: period.year,
      label: spend.label,
      income: currentMonthIncome,
      budget: currentMonthBudget,
      plannedFlow: subtractMoney(currentMonthIncome, currentMonthBudget),
      spent: roundMoney(spend.monthlySpend),
      remaining: roundMoney(spend.remaining),
      uncategorizedSpend: roundMoney(spend.unmatchedSpend),
      byCategory: categories.rows,
      categoryCount: categories.categoryCount,
      categoriesTruncated: categories.truncated,
    },
    reserves: {
      totalBalance: reserveReadiness.totalBalance,
      totalTarget: reserveReadiness.totalTarget,
      overallPercent: reserveReadiness.overallPercent,
      count: reserveReadiness.count,
      funds: reserveFunds(reserveReadiness),
    },
    incomeStreams: incomeRows(streams, period.month),
    yearlyOutlook: {
      year: period.year,
      startingMonth,
      startingTrueCash: roundMoney(startingTrueCash),
      months: yearly.map((month) => ({
        month: month.month,
        plannedIncome: roundMoney(month.plannedIncome),
        actualIncome: roundMoney(month.actualIncome),
        budget: roundMoney(month.budget),
        spent: roundMoney(month.spent),
        profit: roundMoney(month.profit),
      })),
      projectedTrueCash: projected.map((point) => ({
        month: point.month,
        value: point.value == null ? null : roundMoney(point.value),
        profit: point.profit == null ? null : roundMoney(point.profit),
      })),
    },
  };
}

function plaidBalance(row) {
  const balance =
    row.balanceCiphertext != null ? decryptNumber(row.balanceCiphertext) : Number(row.balance || 0);
  return Number.isFinite(balance) ? balance : 0;
}

function plaidAmount(row) {
  const amount =
    row.amountCiphertext != null ? decryptNumber(row.amountCiphertext) : Number(row.amount || 0);
  return Number.isFinite(amount) ? amount : 0;
}

function plaidCategory(row) {
  const category =
    row.categoryCiphertext != null ? decryptField(row.categoryCiphertext) : row.category;
  return category == null ? "" : String(category);
}

function forProfile(rows, profileId) {
  if (!profileId) return rows;
  return rows.filter((row) => row.workspaceUserId === profileId);
}

export async function loadFreedomFinancialPosition(
  userId,
  { now = new Date(), withUser = withUserContext, loadWorkspace = loadSanitizedWorkspaceState } = {}
) {
  if (!userId) {
    return { status: "unavailable", reason: "missing_user", writeAccess: false };
  }

  try {
    const loaded = await loadWorkspace(userId, { withUser });
    const profile = activeWorkspaceUser(loaded?.state);
    const profileId = profile?.id || null;
    const { accounts, transactions } = await withUser(userId, async (tx) => {
      const accountRows = await tx.account.findMany({
        where: { userId },
        select: POSITION_ACCOUNT_SELECT,
      });
      const transactionRows = await tx.transaction.findMany({
        where: { userId, pending: false },
        select: POSITION_TRANSACTION_SELECT,
      });
      return { accounts: accountRows, transactions: transactionRows };
    });

    const plaidAccounts = forProfile(accounts, profileId).map((row) => ({
      type: String(row.type || "Other"),
      balance: plaidBalance(row),
    }));
    const plaidTransactions = forProfile(transactions, profileId).map((row) => ({
      category: plaidCategory(row),
      amount: plaidAmount(row),
      date: formatBudgetDate(row.postedAt),
    }));
    const manualAccounts = Array.isArray(profile?.accounts) ? profile.accounts : [];
    const manualTransactions = (
      Array.isArray(profile?.transactions) ? profile.transactions : []
    ).map((transaction) => ({
      category: transaction?.category,
      amount: transaction?.amount,
      date: transaction?.date || formatBudgetDate(transaction?.postedAt),
    }));

    const dashboard = buildDashboardPosition({
      accounts: [...manualAccounts, ...plaidAccounts],
      transactions: [...manualTransactions, ...plaidTransactions],
      budgetRows: profile?.budgetRows,
      incomeStreams: profile?.incomeStreams,
      plansByYear: profile?.plansByYear,
      createdAt: profile?.createdAt,
      metricSnapshots: profile?.metricSnapshots,
      now,
    });

    return {
      status: loaded?.parseError ? "partial" : "available",
      writeAccess: false,
      profileCount: Array.isArray(loaded?.state?.users)
        ? loaded.state.users.length
        : profile
          ? 1
          : 0,
      manualAccountCount: manualAccounts.length,
      plaidAccountCount: plaidAccounts.length,
      transactionCount: manualTransactions.length + plaidTransactions.length,
      ...dashboard,
    };
  } catch (error) {
    console.warn("[dashboard-position] position failed:", error?.message || error);
    return { status: "unavailable", reason: "load_failed", writeAccess: false };
  }
}

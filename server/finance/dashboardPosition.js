// Read-only Freedom Financial position.
//
// Account identity stays on the normalized records so a total can be opened
// back into the accounts that produced it. Merchants, institutions, account
// numbers, and raw transactions are not copied onto those records.

import { withUserContext } from "../db/prisma.js";
import { buildMonthlySpendSnapshot } from "../../src/utils/budgetReview.js";
import {
  budgetMonthNames,
  budgetMonths,
  BUDGET_CATEGORY_TYPES,
} from "../../src/utils/budgetModel.js";
import { getBudgetPeriodAtOffset, getCurrentBudgetPeriod } from "../../src/utils/date.js";
import { parseMoney } from "../../src/utils/format.js";
import { roundMoney, subtractMoney, sumMoney } from "../../src/utils/money.js";
import { buildPlanYearData, buildProjectedTrueCashSeries } from "../../src/utils/planning.js";
import { buildReserveReadiness, isReserveRow } from "../../src/utils/reserves.js";
import { buildYearlyPlanningMetrics } from "../../src/utils/yearlyPlanningMetrics.js";
import { deriveFinancialPosition } from "../../src/utils/financialPosition.js";
import { mapLoanCategory } from "../mappers.js";
import { decrypt as decryptField, decryptJson, decryptNumber } from "../security/envelope.js";
import { classifyFinanceReadError, queryWithSchemaFallback } from "./schemaRead.js";
import { loadSanitizedWorkspaceState } from "./workspaceSlice.js";

const LABEL_MAX_CHARS = 80;
const CATEGORY_MAX_ENTRIES = 80;

const POSITION_ACCOUNT_SELECT = Object.freeze({
  id: true,
  type: true,
  name: true,
  balance: true,
  balanceCiphertext: true,
  workspaceUserId: true,
  plaidAccountId: true,
  plaidType: true,
  plaidSubtype: true,
  syncSource: true,
  metadata: true,
  metadataCiphertext: true,
});

const LEGACY_POSITION_ACCOUNT_SELECT = Object.freeze({
  id: true,
  type: true,
  name: true,
  balance: true,
  workspaceUserId: true,
  plaidAccountId: true,
  plaidType: true,
  plaidSubtype: true,
  syncSource: true,
  metadata: true,
});

const POSITION_TRANSACTION_SELECT = Object.freeze({
  category: true,
  categoryCiphertext: true,
  amount: true,
  amountCiphertext: true,
  postedAt: true,
  workspaceUserId: true,
});

const LEGACY_POSITION_TRANSACTION_SELECT = Object.freeze({
  category: true,
  amount: true,
  postedAt: true,
  workspaceUserId: true,
});

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

function safeTransactions(transactions) {
  return (Array.isArray(transactions) ? transactions : []).map((transaction) => ({
    amount: transaction?.amount,
    category: typeof transaction?.category === "string" ? transaction.category : "",
    date: typeof transaction?.date === "string" ? transaction.date : "",
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
 * Pure dashboard position. Dollar totals come from deriveFinancialPosition,
 * the same function the dashboard hero uses. Net worth is the real sum.
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
  const ledger = safeTransactions(transactions);
  const rows = Array.isArray(budgetRows) ? budgetRows : [];
  const streams = Array.isArray(incomeStreams) ? incomeStreams : [];
  const plans = plansByYear && typeof plansByYear === "object" ? plansByYear : {};
  const reserveReadiness = buildReserveReadiness(rows.filter(isReserveRow), ledger, {
    asOfMonth: period.month,
    asOfYear: period.year,
  });
  const derived = deriveFinancialPosition(accounts, {
    reservesBalance: reserveReadiness.totalBalance,
  });
  const { trueCash } = derived.position;

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
    position: derived.position,
    totals: derived.totals,
    reconciliation: derived.reconciliation,
    accounts: derived.accounts,
    loans: derived.loans,
    debtAllocation: derived.debtAllocation,
    allocation: derived.allocation,
    holdings: derived.holdings.slice(0, CATEGORY_MAX_ENTRIES),
    balancesByType: derived.balancesByType,
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

function sourceStatus(status, errorClass = null) {
  return { status, errorClass };
}

function readEncryptedNumber(ciphertext, plaintext) {
  if (ciphertext != null) {
    try {
      const value = decryptNumber(ciphertext);
      if (!Number.isFinite(value)) {
        return { ok: false, errorClass: "decrypt" };
      }
      return { ok: true, value };
    } catch {
      return { ok: false, errorClass: "decrypt" };
    }
  }
  const value = Number(plaintext || 0);
  return { ok: true, value: Number.isFinite(value) ? value : 0 };
}

function readMetadata(row) {
  if (row.metadataCiphertext != null) {
    try {
      const value = decryptJson(row.metadataCiphertext);
      return { ok: true, value: value && typeof value === "object" ? value : {} };
    } catch (error) {
      return { ok: false, errorClass: classifyFinanceReadError(error), value: {} };
    }
  }
  const value = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return { ok: true, value };
}

function isPlaidDerivedAccount(account) {
  return Boolean(
    account && (account.syncSource === "Plaid" || account.plaidAccountId || account.plaidItemId)
  );
}

function scopeRows(rows, profileId) {
  if (profileId) {
    return { rows: rows.filter((row) => row.workspaceUserId === profileId), mixed: false };
  }
  const profileIds = new Set(rows.map((row) => row.workspaceUserId).filter(Boolean));
  if (profileIds.size > 1) return { rows: [], mixed: true };
  return { rows, mixed: false };
}

function accountFromPlaidRow(row) {
  const balance = readEncryptedNumber(row.balanceCiphertext, row.balance);
  if (!balance.ok) return { ok: false, errorClass: balance.errorClass };
  const metadata = readMetadata(row);
  const type = String(row.type || "Other");
  const subtype = String(row.plaidSubtype || "");
  const storedCategory = String(metadata.value.loanCategory || "");
  const loanCategory =
    type === "Mortgages / Loans" && !storedCategory && subtype
      ? mapLoanCategory(subtype)
      : storedCategory;
  return {
    ok: true,
    metadataFailed: !metadata.ok,
    errorClass: metadata.ok ? null : metadata.errorClass,
    account: {
      id: row.plaidAccountId ? `plaid-${row.plaidAccountId}` : row.id,
      name: row.name || "",
      type,
      balance: balance.value,
      plaidSubtype: subtype,
      plaidType: row.plaidType || "",
      loanCategory,
      interestRate: metadata.value.interestRate || "",
      monthlyPayment: metadata.value.monthlyPayment || "",
      syncSource: row.syncSource || "Plaid",
      workspaceUserId: row.workspaceUserId,
    },
  };
}

function manualActivity(transactions) {
  return (Array.isArray(transactions) ? transactions : [])
    .filter((transaction) => transaction?.source !== "plaid" && transaction?.syncSource !== "Plaid")
    .map((transaction) => ({
      category: transaction?.category,
      amount: transaction?.amount,
      date: transaction?.date || formatBudgetDate(transaction?.postedAt),
    }));
}

async function readPlaidRows(userId, withUser, profileId) {
  const where = { userId, ...(profileId ? { workspaceUserId: profileId } : {}) };
  const rows = await queryWithSchemaFallback(userId, withUser, async (tx, encrypted) =>
    tx.account.findMany({
      where,
      select: encrypted ? POSITION_ACCOUNT_SELECT : LEGACY_POSITION_ACCOUNT_SELECT,
    })
  );
  return scopeRows(rows, profileId);
}

async function readPlaidLedger(userId, withUser, profileId) {
  const where = { userId, pending: false, ...(profileId ? { workspaceUserId: profileId } : {}) };
  const rows = await queryWithSchemaFallback(userId, withUser, async (tx, encrypted) =>
    tx.transaction.findMany({
      where,
      select: encrypted ? POSITION_TRANSACTION_SELECT : LEGACY_POSITION_TRANSACTION_SELECT,
    })
  );
  const scoped = scopeRows(rows, profileId);
  if (scoped.mixed) return { transactions: [], mixed: true, dropped: 0 };
  const transactions = [];
  let dropped = 0;
  for (const row of scoped.rows) {
    const amount = readEncryptedNumber(row.amountCiphertext, row.amount);
    if (!amount.ok) {
      dropped += 1;
      continue;
    }
    let category;
    if (row.categoryCiphertext != null) {
      try {
        category = String(decryptField(row.categoryCiphertext) ?? "");
      } catch {
        dropped += 1;
        continue;
      }
    } else {
      category = row.category == null ? "" : String(row.category);
    }
    transactions.push({
      category,
      amount: amount.value,
      date: formatBudgetDate(row.postedAt),
    });
  }
  return { transactions, mixed: false, dropped };
}

function unavailablePosition(reason, sources) {
  return {
    status: "unavailable",
    reason,
    writeAccess: false,
    sources,
    accounts: [],
    holdings: [],
    loans: [],
  };
}

/**
 * Authoritative current-position read. Workspace manuals and linked accounts
 * fail independently. A ledger failure does not drop the account position.
 */
export async function loadCurrentPosition(
  userId,
  { now = new Date(), withUser = withUserContext, loadWorkspace = loadSanitizedWorkspaceState } = {}
) {
  const sources = {
    workspace: sourceStatus("unavailable", "query"),
    plaid: sourceStatus("unavailable", "query"),
    ledger: sourceStatus("unavailable", "query"),
  };
  if (!userId) {
    return unavailablePosition("missing_user", sources);
  }

  let profile = null;
  let profileCount = 0;
  try {
    const loaded = await loadWorkspace(userId, { withUser });
    profileCount = Array.isArray(loaded?.state?.users) ? loaded.state.users.length : 0;
    if (loaded?.parseError) {
      sources.workspace = sourceStatus("unavailable", "decrypt");
    } else {
      sources.workspace = sourceStatus("available", null);
      profile = activeWorkspaceUser(loaded?.state);
      if (profile) profileCount = Math.max(profileCount, 1);
    }
  } catch (error) {
    sources.workspace = sourceStatus("unavailable", classifyFinanceReadError(error));
    console.warn("[finance-position] workspace read failed:", error?.message || error);
  }

  const profileId = profile?.id || null;
  let plaidAccounts = [];
  try {
    const scoped = await readPlaidRows(userId, withUser, profileId);
    if (scoped.mixed) {
      sources.plaid = sourceStatus("unavailable", "query");
    } else {
      let dropped = 0;
      let errorClass = null;
      for (const row of scoped.rows) {
        const mapped = accountFromPlaidRow(row);
        if (!mapped.ok) {
          dropped += 1;
          errorClass = mapped.errorClass;
          continue;
        }
        if (mapped.metadataFailed) {
          dropped += 1;
          errorClass = mapped.errorClass;
        }
        plaidAccounts.push(mapped.account);
      }
      if (scoped.rows.length > 0 && plaidAccounts.length === 0) {
        sources.plaid = sourceStatus("unavailable", errorClass || "decrypt");
      } else if (dropped > 0) {
        sources.plaid = sourceStatus("partial", errorClass || "decrypt");
      } else {
        sources.plaid = sourceStatus("available", null);
      }
    }
  } catch (error) {
    sources.plaid = sourceStatus("unavailable", classifyFinanceReadError(error));
    console.warn("[finance-position] linked accounts failed:", error?.message || error);
  }

  const manualAccounts = (Array.isArray(profile?.accounts) ? profile.accounts : []).filter(
    (account) => !isPlaidDerivedAccount(account)
  );
  const manualTransactions = manualActivity(profile?.transactions);

  let plaidTransactions = [];
  try {
    const ledger = await readPlaidLedger(userId, withUser, profileId);
    if (ledger.mixed) {
      sources.ledger = sourceStatus("unavailable", "query");
    } else {
      plaidTransactions = ledger.transactions;
      sources.ledger =
        ledger.dropped > 0
          ? sourceStatus("partial", "decrypt")
          : sourceStatus("available", null);
    }
  } catch (error) {
    sources.ledger = sourceStatus("unavailable", classifyFinanceReadError(error));
    console.warn("[finance-position] linked ledger failed:", error?.message || error);
  }

  const accountSources = [sources.workspace.status, sources.plaid.status];
  const positionStatus = accountSources.every((status) => status === "unavailable")
    ? "unavailable"
    : accountSources.every((status) => status === "available") && sources.ledger.status === "available"
      ? "available"
      : "partial";

  if (positionStatus === "unavailable") {
    return unavailablePosition("load_failed", sources);
  }

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
    status: positionStatus,
    writeAccess: false,
    sources,
    profileId,
    profileCount,
    manualAccountCount: manualAccounts.length,
    plaidAccountCount: plaidAccounts.length,
    transactionCount: manualTransactions.length + plaidTransactions.length,
    securityHoldings: false,
    ...dashboard,
  };
}

export async function loadFreedomFinancialPosition(userId, options) {
  return loadCurrentPosition(userId, options);
}

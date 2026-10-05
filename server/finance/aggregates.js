// Shared financial aggregates. Pure computation plus the minimized select the
// finance agent already proved safe. CHIEF and CEO Agents both call this module.
// It does not import an agent, a model, or CHIEF.

import { withUserContext } from "../db/prisma.js";
import { decrypt as decryptField, decryptNumber } from "../security/envelope.js";
import { isSchemaMismatch, queryWithSchemaFallback } from "./schemaRead.js";

export const AGGREGATION_MONTHS = 6;

// Deliberately minimal: merchants, account names, institutions, and Plaid
// identifiers are not in these selects, so they cannot reach a caller that
// only uses them.
export const FINANCE_TRANSACTION_SELECT = Object.freeze({
  category: true,
  categoryCiphertext: true,
  amount: true,
  amountCiphertext: true,
  postedAt: true,
});

export const FINANCE_ACCOUNT_SELECT = Object.freeze({
  type: true,
  balance: true,
  balanceCiphertext: true,
});

export const FINANCE_PLAID_SELECT = Object.freeze({
  status: true,
  lastSyncAt: true,
  lastSyncError: true,
});

// Pre-encryption selects. Used only after Prisma reports the ciphertext
// column is missing (P2022). Ciphertext wins whenever the column exists.
export const LEGACY_FINANCE_TRANSACTION_SELECT = Object.freeze({
  category: true,
  amount: true,
  postedAt: true,
});

export const LEGACY_FINANCE_ACCOUNT_SELECT = Object.freeze({
  type: true,
  balance: true,
});

export function aggregationWindowStart(now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (AGGREGATION_MONTHS - 1), 1)
  );
}

function monthKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastMonthKeys(now, count) {
  const keys = [];
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = count - 1; i >= 0; i -= 1) {
    keys.push(monthKey(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1))));
  }
  return keys;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function roundPct(value) {
  return Math.round(value * 10) / 10;
}

// Decrypts one transaction row to the minimal { category, amount, month }
// triple, preferring ciphertext and falling back to the legacy plaintext
// columns (same read pattern as server/plaid/handlers.js).
function toAggregateInput(row) {
  const category =
    row.categoryCiphertext != null ? decryptField(row.categoryCiphertext) : row.category;
  const amount =
    row.amountCiphertext != null ? decryptNumber(row.amountCiphertext) : Number(row.amount || 0);
  return {
    category: String(category || "Uncategorized"),
    amount: Number.isFinite(amount) ? amount : 0,
    month: monthKey(row.postedAt),
  };
}

function toBalance(row) {
  const balance =
    row.balanceCiphertext != null ? decryptNumber(row.balanceCiphertext) : Number(row.balance || 0);
  return Number.isFinite(balance) ? balance : 0;
}

/**
 * Pure aggregate computation over raw (possibly encrypted) Transaction and
 * Account rows. Output contains ONLY categories, amounts, month keys and
 * account types.
 */
export function computeFinanceAggregates({ transactions = [], accounts = [], now = new Date() } = {}) {
  const months = lastMonthKeys(now, AGGREGATION_MONTHS);
  const monthSet = new Set(months);

  // month -> category -> signed total
  const totals = new Map();
  let counted = 0;
  for (const row of transactions) {
    const { category, amount, month } = toAggregateInput(row);
    if (!monthSet.has(month)) continue;
    counted += 1;
    if (!totals.has(month)) totals.set(month, new Map());
    const byCategory = totals.get(month);
    byCategory.set(category, (byCategory.get(category) || 0) + amount);
  }

  const monthlyCategoryTotals = [];
  for (const month of months) {
    const byCategory = totals.get(month);
    if (!byCategory) continue;
    for (const [category, total] of [...byCategory.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      monthlyCategoryTotals.push({ month, category, total: round2(total) });
    }
  }

  // Deltas for the latest month: month-over-month and vs the average of the
  // three months preceding it. Percentages compare magnitudes of spend/inflow.
  const latestMonth = months[months.length - 1];
  const previousMonth = months[months.length - 2];
  const trailing = months.slice(-4, -1); // 3 months before the latest
  const categories = new Set();
  for (const byCategory of totals.values()) {
    for (const category of byCategory.keys()) categories.add(category);
  }

  const categoryDeltas = [];
  for (const category of [...categories].sort()) {
    const latestTotal = round2(totals.get(latestMonth)?.get(category) || 0);
    const previousTotal = round2(totals.get(previousMonth)?.get(category) || 0);
    const trailingTotals = trailing.map((m) => totals.get(m)?.get(category) || 0);
    const threeMonthAverage = round2(
      trailingTotals.reduce((sum, v) => sum + v, 0) / (trailing.length || 1)
    );
    const momChangePct =
      Math.abs(previousTotal) > 0.005
        ? roundPct(((Math.abs(latestTotal) - Math.abs(previousTotal)) / Math.abs(previousTotal)) * 100)
        : null;
    const vsThreeMonthAvgPct =
      Math.abs(threeMonthAverage) > 0.005
        ? roundPct(
            ((Math.abs(latestTotal) - Math.abs(threeMonthAverage)) / Math.abs(threeMonthAverage)) * 100
          )
        : null;
    categoryDeltas.push({
      category,
      latestMonth,
      latestTotal,
      previousTotal,
      momChangePct,
      threeMonthAverage,
      vsThreeMonthAvgPct,
    });
  }

  // Balance totals grouped by account TYPE only (e.g. "Checking", "Credit
  // Card") — never account names or institutions.
  const balancesByType = new Map();
  for (const row of accounts) {
    const type = String(row.type || "Other");
    const existing = balancesByType.get(type) || { totalBalance: 0, accountCount: 0 };
    existing.totalBalance += toBalance(row);
    existing.accountCount += 1;
    balancesByType.set(type, existing);
  }
  const accountBalancesByType = [...balancesByType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, { totalBalance, accountCount }]) => ({
      accountType: type,
      totalBalance: round2(totalBalance),
      accountCount,
    }));

  return {
    months,
    transactionCount: counted,
    monthlyCategoryTotals,
    categoryDeltas,
    accountBalancesByType,
  };
}

// Connection counts only. lastSyncError is read so the select matches the
// existing light-health query, and is never returned (it can name an institution).
export function summarizePlaidConnectionHealth(plaidItems = []) {
  const connected = plaidItems.filter((item) => item.status === "CONNECTED").length;
  const lastSyncAt =
    plaidItems
      .map((item) => item.lastSyncAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
  return {
    itemCount: plaidItems.length,
    connectedCount: connected,
    requiresAttentionCount: plaidItems.length - connected,
    lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
  };
}

/**
 * User-scoped read of the proven aggregate plus Plaid connection health.
 * Queries run only on the transaction `withUserContext` provides, so RLS applies.
 */
export async function loadPlaidAggregateInputs(
  userId,
  { now = new Date(), withUser = withUserContext } = {}
) {
  const windowStart = aggregationWindowStart(now);
  return queryWithSchemaFallback(userId, withUser, async (tx, encrypted) => {
    const transactionRows = await tx.transaction.findMany({
      where: { userId, postedAt: { gte: windowStart }, pending: false },
      select: encrypted ? FINANCE_TRANSACTION_SELECT : LEGACY_FINANCE_TRANSACTION_SELECT,
    });
    const accountRows = await tx.account.findMany({
      where: { userId },
      select: encrypted ? FINANCE_ACCOUNT_SELECT : LEGACY_FINANCE_ACCOUNT_SELECT,
    });
    let items;
    try {
      items = await tx.plaidItem.findMany({
        where: { userId },
        select: FINANCE_PLAID_SELECT,
      });
    } catch (error) {
      if (isSchemaMismatch(error)) throw error;
      items = [];
    }
    return { transactions: transactionRows, accounts: accountRows, plaidItems: items };
  });
}

export async function loadFinanceSummary(userId, { now = new Date(), withUser = withUserContext } = {}) {
  const { transactions, accounts, plaidItems } = await loadPlaidAggregateInputs(userId, {
    now,
    withUser,
  });

  return {
    ...computeFinanceAggregates({ transactions, accounts, now }),
    plaid: summarizePlaidConnectionHealth(plaidItems),
  };
}

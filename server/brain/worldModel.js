import { withUserContext } from "../db/prisma.js";
import { decryptNumber } from "../security/envelope.js";
import {
  aggregationWindowStart,
  computeFinanceAggregates,
  FINANCE_ACCOUNT_SELECT,
  FINANCE_PLAID_SELECT,
  FINANCE_TRANSACTION_SELECT,
  summarizePlaidConnectionHealth,
} from "../finance/aggregates.js";
import { loadWorkspacePlanSummary } from "../finance/workspaceSlice.js";

// ─────────────────────────────────────────────────────────────────────────────
// CEO world-model loaders — trusted, read-only application state.
//
// Phase 1 rules:
//   • Only server-computable summaries (no client React formula reuse).
//   • Privacy bar matches the finance agent: no merchants, account names/numbers,
//     or raw transaction history in the CEO prompt.
//   • Missing domains are explicit: { status: "unavailable_server_summary" }.
//   • Deep finance aggregates are cached (TTL); light health is always-on.
// ─────────────────────────────────────────────────────────────────────────────

/** Deep aggregates TTL — refreshed periodically, not blindly every turn. */
export const FINANCE_AGGREGATES_CACHE_TTL_MS = 10 * 60 * 1000;
/** Cap category rows shown in the CEO prompt. */
const CATEGORY_DELTA_PROMPT_LIMIT = 12;

/** @type {Map<string, { aggregates: object, loadedAt: number, accountCount: number, transactionCount: number }>} */
const financeAggregatesCache = new Map();

const UNAVAILABLE = Object.freeze({ status: "unavailable_server_summary" });

export function unavailableServerSummary(domain) {
  return { domain, status: "unavailable_server_summary" };
}

/** Test helper — clears the in-process aggregates cache. */
export function resetFinanceAggregatesCacheForTesting() {
  financeAggregatesCache.clear();
}

/**
 * Always-on lightweight financial + connection health (cheap: accounts + items).
 * No transaction decryption.
 */
export async function loadLightFinancialHealth(userId) {
  if (!userId) {
    return {
      status: "unavailable_server_summary",
      reason: "missing_user",
    };
  }

  try {
    return await withUserContext(userId, async (tx) => {
      const [accounts, plaidItems] = await Promise.all([
        tx.account.findMany({
          where: { userId },
          select: FINANCE_ACCOUNT_SELECT,
        }),
        tx.plaidItem.findMany({
          where: { userId },
          select: FINANCE_PLAID_SELECT,
        }),
      ]);

      const balancesByType = summarizeBalancesByType(accounts);

      return {
        status: "available",
        accountCount: accounts.length,
        balancesByType,
        // Never include institution names / item ids in CEO world model.
        plaid: summarizePlaidConnectionHealth(plaidItems),
      };
    });
  } catch (error) {
    console.warn("[ceo-world-model] light financial health failed:", error?.message || error);
    return {
      status: "unavailable_server_summary",
      reason: "load_failed",
    };
  }
}

/**
 * Deep finance aggregates — cached by userId with TTL.
 * Uses the same minimized SELECT as the finance agent.
 */
export async function loadFinanceAggregatesCached(userId, { now = new Date(), force = false } = {}) {
  if (!userId) {
    return { status: "unavailable_server_summary", reason: "missing_user" };
  }

  const cached = financeAggregatesCache.get(userId);
  const ageMs = cached ? Date.now() - cached.loadedAt : null;
  if (!force && cached && ageMs != null && ageMs < FINANCE_AGGREGATES_CACHE_TTL_MS) {
    return {
      status: "available",
      cache: { hit: true, ageMs, ttlMs: FINANCE_AGGREGATES_CACHE_TTL_MS },
      summary: summarizeAggregatesForCeo(cached.aggregates),
      accountCount: cached.accountCount,
      transactionCount: cached.transactionCount,
    };
  }

  try {
    const windowStart = aggregationWindowStart(now);
    const { transactions, accounts } = await withUserContext(userId, async (tx) => {
      const transactionRows = await tx.transaction.findMany({
        where: { userId, postedAt: { gte: windowStart }, pending: false },
        select: FINANCE_TRANSACTION_SELECT,
      });
      const accountRows = await tx.account.findMany({
        where: { userId },
        select: FINANCE_ACCOUNT_SELECT,
      });
      return { transactions: transactionRows, accounts: accountRows };
    });

    const aggregates = computeFinanceAggregates({ transactions, accounts, now });
    financeAggregatesCache.set(userId, {
      aggregates,
      loadedAt: Date.now(),
      accountCount: accounts.length,
      transactionCount: transactions.length,
    });

    return {
      status: "available",
      cache: { hit: false, ageMs: 0, ttlMs: FINANCE_AGGREGATES_CACHE_TTL_MS },
      summary: summarizeAggregatesForCeo(aggregates),
      accountCount: accounts.length,
      transactionCount: transactions.length,
    };
  } catch (error) {
    console.warn("[ceo-world-model] finance aggregates failed:", error?.message || error);
    if (cached) {
      return {
        status: "available",
        cache: { hit: true, ageMs, ttlMs: FINANCE_AGGREGATES_CACHE_TTL_MS, staleFallback: true },
        summary: summarizeAggregatesForCeo(cached.aggregates),
        accountCount: cached.accountCount,
        transactionCount: cached.transactionCount,
      };
    }
    return {
      status: "unavailable_server_summary",
      reason: "load_failed",
    };
  }
}

/**
 * Workspace snapshot slices — counts, labels, stored metric fields only.
 * Does not recompute True Cash / forecast / budget-vs-actual.
 * The slice itself lives in server/finance/workspaceSlice.js so CHIEF can
 * reuse it without importing this module.
 */
export async function loadWorkspaceWorldSlice(userId) {
  return loadWorkspacePlanSummary(userId);
}

/**
 * Full application-state world model for one CEO turn.
 */
export async function buildApplicationWorldModel(userId, { now = new Date() } = {}) {
  const [lightFinancial, financeAggregates, workspace] = await Promise.all([
    loadLightFinancialHealth(userId),
    loadFinanceAggregatesCached(userId, { now }),
    loadWorkspaceWorldSlice(userId),
  ]);

  return {
    financial: {
      lightHealth: lightFinancial,
      aggregates: financeAggregates,
      // Domains that require client-only formulas — never invent them here.
      budgetStatusVsActual: { ...UNAVAILABLE },
      trueCash: { ...UNAVAILABLE },
      forecast: { ...UNAVAILABLE },
      operationsBoard: { ...UNAVAILABLE },
    },
    workspace,
    connectedServices: {
      plaid: lightFinancial?.plaid || { status: "unavailable_server_summary" },
    },
  };
}

/** Prompt-safe compact aggregate summary (no merchants / account ids). */
export function summarizeAggregatesForCeo(aggregates) {
  if (!aggregates) return null;
  const deltas = Array.isArray(aggregates.categoryDeltas)
    ? aggregates.categoryDeltas
        .slice()
        .sort(
          (a, b) =>
            Math.abs(b.vsThreeMonthAvgPct ?? b.momChangePct ?? 0) -
            Math.abs(a.vsThreeMonthAvgPct ?? a.momChangePct ?? 0)
        )
        .slice(0, CATEGORY_DELTA_PROMPT_LIMIT)
    : [];

  return {
    months: aggregates.months || [],
    transactionCount: aggregates.transactionCount ?? 0,
    accountBalancesByType: aggregates.accountBalancesByType || [],
    notableCategoryDeltas: deltas.map((row) => ({
      category: row.category,
      latestMonth: row.latestMonth,
      latestTotal: row.latestTotal,
      momChangePct: row.momChangePct,
      vsThreeMonthAvgPct: row.vsThreeMonthAvgPct,
    })),
  };
}

function summarizeBalancesByType(accounts) {
  const map = new Map();
  for (const row of accounts || []) {
    const type = String(row.type || "Other");
    const balance =
      row.balanceCiphertext != null
        ? decryptNumber(row.balanceCiphertext)
        : Number(row.balance || 0);
    const existing = map.get(type) || { totalBalance: 0, accountCount: 0 };
    existing.totalBalance += Number.isFinite(balance) ? balance : 0;
    existing.accountCount += 1;
    map.set(type, existing);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([accountType, { totalBalance, accountCount }]) => ({
      accountType,
      totalBalance: Math.round(totalBalance * 100) / 100,
      accountCount,
    }));
}


import { withUserContext } from "../db/prisma.js";
import { getSchemaCapabilities } from "../db/schemaCapabilities.js";
import { decryptJson, decryptNumber } from "../security/envelope.js";
import { computeFinanceAggregates } from "../agents/types/finance.js";
import { sanitizeWorkspaceStateForPersistence } from "../../src/utils/workspacePersistence.js";

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

const AGGREGATION_MONTHS = 6;
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
          select: { type: true, balance: true, balanceCiphertext: true },
        }),
        tx.plaidItem.findMany({
          where: { userId },
          select: {
            status: true,
            lastSyncAt: true,
            lastSyncError: true,
          },
        }),
      ]);

      const balancesByType = summarizeBalancesByType(accounts);
      const connected = plaidItems.filter((item) => item.status === "CONNECTED").length;
      const attention = plaidItems.length - connected;
      const lastSyncAt = plaidItems
        .map((item) => item.lastSyncAt)
        .filter(Boolean)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;

      return {
        status: "available",
        accountCount: accounts.length,
        balancesByType,
        plaid: {
          itemCount: plaidItems.length,
          connectedCount: connected,
          requiresAttentionCount: attention,
          lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
          // Never include institution names / item ids in CEO world model.
        },
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
    const windowStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (AGGREGATION_MONTHS - 1), 1)
    );
    const { transactions, accounts } = await withUserContext(userId, async (tx) => {
      const transactionRows = await tx.transaction.findMany({
        where: { userId, postedAt: { gte: windowStart }, pending: false },
        select: {
          category: true,
          categoryCiphertext: true,
          amount: true,
          amountCiphertext: true,
          postedAt: true,
        },
      });
      const accountRows = await tx.account.findMany({
        where: { userId },
        select: { type: true, balance: true, balanceCiphertext: true },
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
 */
export async function loadWorkspaceWorldSlice(userId) {
  if (!userId) {
    return { status: "unavailable_server_summary", reason: "missing_user" };
  }

  try {
    const caps = await getSchemaCapabilities().catch(() => ({ encryptionColumns: true }));
    const snapshot = await withUserContext(userId, async (tx) => {
      if (caps.encryptionColumns !== false) {
        return tx.workspaceSnapshot.findUnique({ where: { userId } });
      }
      return tx.workspaceSnapshot.findUnique({
        where: { userId },
        select: {
          id: true,
          userId: true,
          state: true,
          source: true,
          lastClientUpdatedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    if (!snapshot) {
      return {
        status: "available",
        hasSnapshot: false,
        updatedAt: null,
        workspaceUserCount: 0,
        budgetRowCount: 0,
        budgetCategoryLabels: [],
        incomeStreamCount: 0,
        incomeStreamLabels: [],
        objectiveCount: 0,
        planYears: [],
        storedMetricSnapshots: { status: "unavailable_server_summary", count: 0 },
      };
    }

    let state = null;
    try {
      if (snapshot.stateCiphertext != null) {
        state = decryptJson(snapshot.stateCiphertext);
      } else {
        state = snapshot.state ?? null;
      }
      state = sanitizeWorkspaceStateForPersistence(state);
    } catch {
      state = null;
    }

    if (!state || typeof state !== "object") {
      return {
        status: "available",
        hasSnapshot: true,
        updatedAt: snapshot.updatedAt ? new Date(snapshot.updatedAt).toISOString() : null,
        parseError: true,
        workspaceUserCount: 0,
        budgetRowCount: 0,
        budgetCategoryLabels: [],
        incomeStreamCount: 0,
        incomeStreamLabels: [],
        objectiveCount: 0,
        planYears: [],
        storedMetricSnapshots: { status: "unavailable_server_summary", count: 0 },
      };
    }

    const users = Array.isArray(state.users) ? state.users : [];
    const activeUser =
      users.find((u) => u?.id && u.id === state.activeUserId) || users[0] || null;

    const budgetRows = Array.isArray(activeUser?.budgetRows) ? activeUser.budgetRows : [];
    const incomeStreams = Array.isArray(activeUser?.incomeStreams)
      ? activeUser.incomeStreams
      : [];
    const objectives = Array.isArray(activeUser?.objectives) ? activeUser.objectives : [];
    const plansByYear =
      activeUser?.plansByYear && typeof activeUser.plansByYear === "object"
        ? activeUser.plansByYear
        : {};
    const metricSnapshots = Array.isArray(activeUser?.metricSnapshots)
      ? activeUser.metricSnapshots
      : [];

    const latestMetric = metricSnapshots.length
      ? metricSnapshots[metricSnapshots.length - 1]
      : null;

    return {
      status: "available",
      hasSnapshot: true,
      updatedAt: snapshot.updatedAt ? new Date(snapshot.updatedAt).toISOString() : null,
      source: snapshot.source || null,
      workspaceUserCount: users.length,
      activeUserPresent: Boolean(activeUser),
      budgetRowCount: budgetRows.length,
      budgetCategoryLabels: uniqueLabels(
        budgetRows.map((row) => row?.name || row?.category || row?.label)
      ),
      incomeStreamCount: incomeStreams.length,
      incomeStreamLabels: uniqueLabels(incomeStreams.map((row) => row?.name || row?.label)),
      objectiveCount: objectives.length,
      planYears: Object.keys(plansByYear)
        .map(String)
        .sort(),
      storedMetricSnapshots: latestMetric
        ? {
            status: "available",
            count: metricSnapshots.length,
            latest: summarizeStoredMetricSnapshot(latestMetric),
          }
        : { status: "unavailable_server_summary", count: 0 },
    };
  } catch (error) {
    console.warn("[ceo-world-model] workspace slice failed:", error?.message || error);
    return {
      status: "unavailable_server_summary",
      reason: "load_failed",
    };
  }
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

function summarizeStoredMetricSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return { status: "unavailable_server_summary" };
  }
  // Pass through only already-stored numeric/summary fields — do not recompute.
  const allowedKeys = [
    "trueCash",
    "liquidCash",
    "creditCardDebt",
    "reserves",
    "capturedAt",
    "asOf",
    "date",
    "month",
    "year",
  ];
  const out = {};
  for (const key of allowedKeys) {
    if (snapshot[key] == null) continue;
    const value = snapshot[key];
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return {
    status: Object.keys(out).length ? "available" : "unavailable_server_summary",
    fields: out,
    fieldNames: Object.keys(out),
  };
}

function uniqueLabels(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const label = String(value || "").trim();
    if (!label || label.length > 80) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= 40) break;
  }
  return out;
}

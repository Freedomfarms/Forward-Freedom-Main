// Historical Freedom Financial activity.
//
// Separate from the current-position read. A failure here must not be treated
// as a failure of what the user owns or owes right now.

import { aggregationWindowStart, computeFinanceAggregates, loadPlaidAggregateInputs, summarizePlaidConnectionHealth } from "./aggregates.js";
import { classifyFinanceReadError } from "./schemaRead.js";
import { activeWorkspaceUser } from "./dashboardPosition.js";
import { loadSanitizedWorkspaceState } from "./workspaceSlice.js";
import { withUserContext } from "../db/prisma.js";

function sourceStatus(status, errorClass = null) {
  return { status, errorClass };
}

function parseActivityDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) return date;
  return null;
}

function manualRows(profile, windowStart) {
  const transactions = Array.isArray(profile?.transactions) ? profile.transactions : [];
  const rows = [];
  for (const transaction of transactions) {
    if (transaction?.source === "plaid" || transaction?.syncSource === "Plaid" || transaction?.plaidTransactionId) {
      continue;
    }
    const postedAt = parseActivityDate(transaction?.date || transaction?.postedAt);
    if (!postedAt || postedAt < windowStart) continue;
    const amount = Number(transaction?.amount || 0);
    rows.push({
      category: transaction?.category == null ? "" : String(transaction.category),
      categoryCiphertext: null,
      amount: Number.isFinite(amount) ? amount : 0,
      amountCiphertext: null,
      postedAt,
    });
  }
  return rows;
}

export async function loadFinancialActivity(
  userId,
  {
    now = new Date(),
    withUser = withUserContext,
    loadWorkspace = loadSanitizedWorkspaceState,
  } = {}
) {
  const sources = {
    workspace: sourceStatus("unavailable", "query"),
    plaid: sourceStatus("unavailable", "query"),
  };
  if (!userId) {
    return {
      status: "unavailable",
      reason: "missing_user",
      writeAccess: false,
      sources,
      securityHoldings: false,
    };
  }

  let plaidInputs = { transactions: [], accounts: [], plaidItems: [] };
  try {
    plaidInputs = await loadPlaidAggregateInputs(userId, { now, withUser });
    sources.plaid = sourceStatus("available", null);
  } catch (error) {
    sources.plaid = sourceStatus("unavailable", classifyFinanceReadError(error));
    console.warn("[finance-activity] linked activity failed:", error?.message || error);
  }

  let manual = [];
  try {
    const loaded = await loadWorkspace(userId, { withUser });
    if (loaded?.parseError) {
      sources.workspace = sourceStatus("unavailable", "decrypt");
    } else {
      sources.workspace = sourceStatus("available", null);
      const profile = activeWorkspaceUser(loaded?.state);
      manual = manualRows(profile, aggregationWindowStart(now));
    }
  } catch (error) {
    sources.workspace = sourceStatus("unavailable", classifyFinanceReadError(error));
    console.warn("[finance-activity] workspace activity failed:", error?.message || error);
  }

  const status =
    sources.workspace.status === "available" && sources.plaid.status === "available"
      ? "available"
      : sources.workspace.status === "unavailable" && sources.plaid.status === "unavailable"
        ? "unavailable"
        : "partial";

  const aggregates = computeFinanceAggregates({
    transactions: [...plaidInputs.transactions, ...manual],
    accounts: plaidInputs.accounts,
    now,
  });

  return {
    status,
    writeAccess: false,
    sources,
    securityHoldings: false,
    ...aggregates,
    plaid:
      sources.plaid.status === "available"
        ? summarizePlaidConnectionHealth(plaidInputs.plaidItems)
        : { status: "unavailable", errorClass: sources.plaid.errorClass },
  };
}

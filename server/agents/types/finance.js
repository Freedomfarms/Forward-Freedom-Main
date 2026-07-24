import { withUserContext } from "../../db/prisma.js";
import { decrypt as decryptField, decryptNumber } from "../../security/envelope.js";
import { generateAgentObject } from "../llm.js";
import { dataSection, DEFAULT_REPORT_STYLE_RULE, PROMPT_SAFETY_RULES } from "../prompts.js";
import { jsonSchema } from "ai";

// ─────────────────────────────────────────────────────────────────────────────
// Finance agent (read-only, observations only).
//
// Data minimization: ALL aggregation happens server-side. Only aggregates —
// category, amount, date (month) and account-TYPE balance totals — are ever
// sent to Anthropic. Merchant names, account names/IDs, institution names and
// Plaid identifiers are never even SELECTed from the database here, so they
// structurally cannot reach a prompt, a run summary, or a digest.
// ─────────────────────────────────────────────────────────────────────────────

const AGGREGATION_MONTHS = 6;

export const FINANCE_SYSTEM_PROMPT = [
  "You are the Finance agent inside Freedom OS, a personal-finance workspace. You are a read-only observer.",
  "You receive pre-computed spending aggregates (per-category monthly totals, month-over-month and vs-3-month-average deltas, and balance totals grouped by account type). You never see raw transactions.",
  "Your job is to surface OBSERVATIONS AND PATTERNS ONLY — for example: \"dining spend is 40% above your 3-month average\".",
  "You must NEVER give prescriptive advice or directives of any kind. Forbidden: telling the user to buy X, sell Y, move money to Z, open or close accounts, change investments, or any investment recommendation whatsoever. Do not suggest actions; only describe what the data shows.",
  "Amounts are signed: negative values are money going out, positive values are money coming in.",
  "If the data is too sparse to say anything meaningful, say so plainly.",
  DEFAULT_REPORT_STYLE_RULE,
  "If the user's instructions explicitly request a different format or style, follow that instead of the default.",
  "Safety rules:",
  `- ${PROMPT_SAFETY_RULES}`,
].join("\n");

const FINANCE_REPORT_SCHEMA = jsonSchema({
  type: "object",
  properties: {
    report: {
      type: "string",
      description:
        "A short Markdown desk-brief of notable observations and patterns in the aggregates. Use ## section headings, **bold** key numbers, and short paragraphs or bullets. End with a ## Summary section of 2-4 sentences.",
    },
    summary: {
      type: "string",
      description:
        "A 2-4 sentence plain-text (or lightly bolded Markdown) summary of the most important observation(s) — matches the report's ## Summary section.",
    },
  },
  required: ["report", "summary"],
  additionalProperties: false,
});

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
 * account types — this object is exactly what gets serialized into the prompt.
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

// Builds the full user message. Exported so tests can assert the payload
// contains no merchant/account/institution strings.
export function buildFinanceUserMessage({ aggregates, instructions, definitionOfDone }) {
  return [
    "Analyze the following pre-computed financial aggregates and produce your observations-only report.",
    dataSection("AGENT INSTRUCTIONS (user-configured)", instructions),
    dataSection("DEFINITION OF DONE (user-configured)", definitionOfDone),
    dataSection("FINANCIAL AGGREGATES (server-computed JSON)", JSON.stringify(aggregates, null, 2)),
  ].join("\n\n");
}

export async function runFinanceAgent({ userId, config }) {
  const now = new Date();
  const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (AGGREGATION_MONTHS - 1), 1));

  const { transactions, accounts } = await withUserContext(userId, async (tx) => {
    // Deliberately minimal SELECT: merchant columns and any account/Plaid
    // identifiers are never read by this agent.
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
  const { object, usage } = await generateAgentObject({
    model: config.model,
    system: FINANCE_SYSTEM_PROMPT,
    prompt: buildFinanceUserMessage({
      aggregates,
      instructions: config.instructions,
      definitionOfDone: config.definitionOfDone,
    }),
    schema: FINANCE_REPORT_SCHEMA,
    maxOutputTokens: 1500,
  });

  return {
    summary: object.summary,
    output: object.report,
    usage,
    model: config.model,
    dataAccessed: {
      description:
        "Read the user's transactions and accounts, aggregated server-side; only category/amount/month aggregates and account-type balance totals were sent to the model.",
      transactions: {
        count: transactions.length,
        window: { months: AGGREGATION_MONTHS, since: aggregates.months[0] },
        fields: ["category", "amount", "postedAt"],
      },
      accounts: { count: accounts.length, fields: ["type", "balance"] },
    },
  };
}

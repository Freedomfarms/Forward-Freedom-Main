import { withUserContext } from "../../db/prisma.js";
import {
  AGGREGATION_MONTHS,
  aggregationWindowStart,
  computeFinanceAggregates,
  FINANCE_ACCOUNT_SELECT,
  FINANCE_TRANSACTION_SELECT,
} from "../../finance/aggregates.js";
import { generateAgentObject } from "../llm.js";
import { dataSection, DEFAULT_REPORT_STYLE_RULE, PROMPT_SAFETY_RULES } from "../prompts.js";
import { jsonSchema } from "ai";

export { computeFinanceAggregates };

// ─────────────────────────────────────────────────────────────────────────────
// Finance agent (read-only, observations only).
//
// Data minimization: ALL aggregation happens server-side. Only aggregates —
// category, amount, date (month) and account-TYPE balance totals — are ever
// sent to Anthropic. Merchant names, account names/IDs, institution names and
// Plaid identifiers are never even SELECTed from the database here, so they
// structurally cannot reach a prompt, a run summary, or a digest.
// ─────────────────────────────────────────────────────────────────────────────

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
  const windowStart = aggregationWindowStart(now);

  const { transactions, accounts } = await withUserContext(userId, async (tx) => {
    // Deliberately minimal SELECT: merchant columns and any account/Plaid
    // identifiers are never read by this agent.
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

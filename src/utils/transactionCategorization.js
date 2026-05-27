import { transactionCategoryOptions } from "../data/constants.jsx";

const REVIEW_THRESHOLD = 70;
const HIGH_CONFIDENCE = 85;

const MERCHANT_CATEGORY_RULES = [
  {
    pattern: /\bNETFLIX\b|\bSPOTIFY\b|\bHULU\b|\bDISNEY\b|\bAPPLE ONE\b/,
    category: "Subscriptions",
    confidence: 92,
  },
  {
    pattern:
      /\bWHOLE FOODS\b|\bTRADER JOE'?S\b|\bKROGER\b|\bSAFEWAY\b|\bALDI\b|\bPUBLIX\b|\bCOSTCO\b/,
    category: "Groceries",
    confidence: 90,
  },
  { pattern: /\bWALMART\b|\bTARGET\b/, category: "Shopping", confidence: 72 },
  {
    pattern: /\bCHEVRON\b|\bSHELL\b|\bEXXON\b|\bMOBIL\b|\bBP\b|\bSUNOCO\b|\bTESLA SUPERCHARGER\b/,
    category: "Fuel",
    confidence: 92,
  },
  {
    pattern: /\bUBER\b|\bLYFT\b|\bDELTA\b|\bUNITED\b|\bSOUTHWEST\b/,
    category: "Transportation",
    confidence: 84,
  },
  {
    pattern: /\bAT&T\b|\bVERIZON\b|\bCOMCAST\b|\bXFINITY\b|\bELECTRIC\b|\bUTILITY\b/,
    category: "Utilities",
    confidence: 90,
  },
  { pattern: /\bAMAZON\b/, category: "Shopping", confidence: 82 },
  { pattern: /\bCVS\b|\bWALGREENS\b|\bPHARMACY\b/, category: "Health & Wellness", confidence: 86 },
  { pattern: /\bHOME DEPOT\b|\bLOWE'?S\b/, category: "Home Improvement", confidence: 88 },
  { pattern: /\bMORTGAGE\b|\bROCKET MORTGAGE\b|\bRENT\b/, category: "Housing", confidence: 94 },
  { pattern: /\bPAYROLL\b|\bDIRECT DEP\b|\bSALARY\b/, category: "Income", confidence: 95 },
  { pattern: /\bDIVIDEND\b/, category: "Investments", confidence: 88 },
  { pattern: /\bBEST BUY\b|\bMICRO CENTER\b|\bAPPLE\b/, category: "Technology", confidence: 84 },
  {
    pattern: /\bEPAY\b|\bEPAYMENT\b|\bPYMT\b|\bPYMNT\b/,
    category: "Transfers",
    confidence: 88,
  },
];

const PLAID_CATEGORY_RULES = [
  { pattern: /INCOME/, category: "Income", confidence: 86 },
  { pattern: /GROCER/, category: "Groceries", confidence: 82 },
  { pattern: /FOOD_AND_DRINK|RESTAURANT/, category: "Restaurants & Coffee", confidence: 82 },
  { pattern: /ENTERTAINMENT/, category: "Entertainment", confidence: 78 },
  { pattern: /GENERAL_MERCHANDISE|SHOPPING/, category: "Shopping", confidence: 76 },
  { pattern: /UTILITY/, category: "Utilities", confidence: 84 },
  { pattern: /TRAVEL/, category: "Travel", confidence: 80 },
  { pattern: /TRANSPORT/, category: "Transportation", confidence: 76 },
  { pattern: /GAS/, category: "Fuel", confidence: 84 },
  { pattern: /INVESTMENT/, category: "Investments", confidence: 78 },
  { pattern: /CREDIT_CARD_PAYMENT|LOAN_PAYMENTS/, category: "Transfers", confidence: 90 },
  { pattern: /TRANSFER/, category: "Transfers", confidence: 74 },
  { pattern: /HEALTH/, category: "Health & Wellness", confidence: 78 },
  { pattern: /INSURANCE/, category: "Insurance", confidence: 84 },
  { pattern: /HOUSING|MORTGAGE|RENT/, category: "Housing", confidence: 86 },
];

export function normalizeMerchantName(merchant) {
  return String(merchant || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\b(PAYMENT|PURCHASE|DEBIT|CREDIT|POS|ONLINE|ACH|CARD)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildValidCategorySet(budgetRows) {
  return new Set([
    ...transactionCategoryOptions,
    ...budgetRows.map((row) => row.name).filter(Boolean),
    "Income",
    "Transfers",
    "Other",
  ]);
}

function buildBudgetCategoryAliasMap(budgetRows) {
  const aliasMap = new Map();

  budgetRows.forEach((row) => {
    [row.name, ...(row.transactionCategories || [])].filter(Boolean).forEach((alias) => {
      aliasMap.set(String(alias).trim(), row.name);
    });
  });

  return aliasMap;
}

function normalizeBudgetCategory(category, aliasMap) {
  const normalized = String(category || "").trim();
  if (!normalized) return "";
  return aliasMap.get(normalized) || normalized;
}

function pickRuleCategory(text, validCategories, rules) {
  const normalizedText = String(text || "").toUpperCase();

  for (const rule of rules) {
    if (rule.pattern.test(normalizedText) && validCategories.has(rule.category)) {
      return {
        category: rule.category,
        confidence: rule.confidence,
      };
    }
  }

  return null;
}

function clampConfidence(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function buildCategorizedTransaction(transaction, nextCategory, source, confidence) {
  const nextConfidence = clampConfidence(confidence);
  return {
    ...transaction,
    category: nextCategory,
    categorySource: source,
    categoryConfidence: nextConfidence,
    needsReview: nextConfidence < REVIEW_THRESHOLD,
  };
}

export function categorizeTransaction(transaction, { budgetRows, merchantCategoryRules = {} }) {
  const validCategories = buildValidCategorySet(budgetRows);
  const aliasMap = buildBudgetCategoryAliasMap(budgetRows);
  const normalizedMerchant = normalizeMerchantName(transaction.merchant);
  const normalizedTransactionCategory = normalizeBudgetCategory(transaction.category, aliasMap);
  const lockedByUser = transaction.categorySource === "user";
  const lockedManual = transaction.source === "manual" && transaction.category;

  if (lockedByUser) {
    return buildCategorizedTransaction(
      transaction,
      validCategories.has(normalizedTransactionCategory) ? normalizedTransactionCategory : "Other",
      "user",
      100
    );
  }

  if (lockedManual) {
    return buildCategorizedTransaction(
      transaction,
      validCategories.has(normalizedTransactionCategory) ? normalizedTransactionCategory : "Other",
      "manual",
      100
    );
  }

  const learnedCategory = normalizeBudgetCategory(merchantCategoryRules[normalizedMerchant], aliasMap);
  if (learnedCategory && validCategories.has(learnedCategory)) {
    return buildCategorizedTransaction(transaction, learnedCategory, "learned", 98);
  }

  const merchantMatch = pickRuleCategory(
    normalizedMerchant,
    validCategories,
    MERCHANT_CATEGORY_RULES
  );
  const plaidMatch = pickRuleCategory(
    `${transaction.category || ""} ${normalizedTransactionCategory}`,
    validCategories,
    PLAID_CATEGORY_RULES
  );

  if (merchantMatch && plaidMatch && merchantMatch.category === plaidMatch.category) {
    return buildCategorizedTransaction(
      transaction,
      merchantMatch.category,
      "ai",
      Math.max(merchantMatch.confidence, plaidMatch.confidence) + 6
    );
  }

  if (merchantMatch && merchantMatch.confidence >= HIGH_CONFIDENCE) {
    return buildCategorizedTransaction(
      transaction,
      merchantMatch.category,
      "ai",
      merchantMatch.confidence
    );
  }

  if (normalizedTransactionCategory && validCategories.has(normalizedTransactionCategory)) {
    return buildCategorizedTransaction(
      transaction,
      normalizedTransactionCategory,
      transaction.source === "plaid" ? "plaid" : transaction.categorySource || "ai",
      plaidMatch?.confidence || merchantMatch?.confidence || 76
    );
  }

  if (merchantMatch) {
    return buildCategorizedTransaction(
      transaction,
      merchantMatch.category,
      "ai",
      merchantMatch.confidence
    );
  }

  if (plaidMatch) {
    return buildCategorizedTransaction(
      transaction,
      plaidMatch.category,
      "plaid",
      plaidMatch.confidence
    );
  }

  return buildCategorizedTransaction(transaction, "Other", "ai", 42);
}

export function categorizeTransactions(transactions, options) {
  return transactions.map((transaction) => categorizeTransaction(transaction, options));
}

export function buildMerchantCategoryRules(currentRules, merchant, category) {
  const normalizedMerchant = normalizeMerchantName(merchant);
  if (!normalizedMerchant || !category) return currentRules;

  return {
    ...currentRules,
    [normalizedMerchant]: category,
  };
}

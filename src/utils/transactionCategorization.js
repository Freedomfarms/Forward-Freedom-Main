import { UNCATEGORIZED_CATEGORY, transactionCategoryOptions } from "../data/constants.jsx";

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

// Words that appear in card descriptors but never identify the merchant.
const GENERIC_DESCRIPTOR_WORDS =
  /\b(PAYMENT|PURCHASE|DEBIT|CREDIT|POS|ONLINE|ACH|CARD|AUTHORIZED|RECURRING|CHECKCARD)\b/g;

function collapseDescriptor(text) {
  return String(text || "")
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(GENERIC_DESCRIPTOR_WORDS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Bank card descriptors bury the merchant identity in per-swipe noise, e.g.
// "PURCHASE AUTHORIZED ON 08/24 P&W MIDDLETOWN CT S466236607143302 CARD 6709".
// Learned category rules are keyed by this normalization, so anything that
// changes between two visits to the same merchant — swipe dates, reference /
// serial numbers, card suffixes — must be stripped, or a rule taught on one
// swipe can never match the next. Short (1-2 digit) numbers are kept so names
// like "FOREVER 21" survive. Re-running on an already-normalized key yields
// the same key, which lets stored rule keys from the older, looser
// normalization migrate through this same function.
export function normalizeMerchantName(merchant) {
  const raw = String(merchant || "").toUpperCase();
  const stable = raw
    // Space-separated swipe dates anchored on "ON" ("ON 08 24"), the form
    // found in keys saved by the pre-migration normalizer (which had already
    // stripped the slashes). Must run before the phrase strip below removes
    // the "ON" anchor.
    .replace(/\bON\s+\d{1,2}\s+\d{1,2}(?:\s+\d{2,4})?\b/g, " ")
    // Slash/dash swipe dates: "08/24", "8-24-26".
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ")
    // Remaining "AUTHORIZED ON" boilerplate, stripped as a phrase so the
    // dangling "ON" never leaks into the key once its date is removed.
    .replace(/\bAUTHORIZED\s+ON\b/g, " ")
    // Card suffixes ("CARD 6709") and masked numbers ("XXXXXX1234").
    .replace(/\bCARD\s*#?\s*\d+\b/g, " ")
    .replace(/\bX{2,}\d+\b/g, " ")
    // Reference/serial tokens (anything with a 5+ digit run) and standalone
    // 3+ digit numbers (store/batch/phone fragments).
    .replace(/\b[A-Z]*\d{5,}[A-Z0-9]*\b/g, " ")
    .replace(/\b\d{3,}\b/g, " ");
  // A descriptor that was ALL noise still needs a non-empty, deterministic
  // key, so fall back to collapsing the raw text.
  return collapseDescriptor(stable) || collapseDescriptor(raw);
}

// Re-keys a stored rule map through the current merchant normalization.
// Rules learned before volatile-token stripping were keyed with per-swipe
// noise (dates, reference numbers) baked in, so they could never match a
// future transaction. Run at consumption time because server-hydrated
// workspace state does not pass through the load-time normalizers.
export function normalizeMerchantCategoryRules(rules) {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return {};

  const normalized = {};
  Object.entries(rules).forEach(([merchant, category]) => {
    if (typeof category !== "string" || !category.trim()) return;
    const key = normalizeMerchantName(merchant);
    if (key) normalized[key] = category.trim();
  });
  return normalized;
}

function buildValidCategorySet(budgetRows) {
  return new Set([
    ...transactionCategoryOptions,
    ...budgetRows.map((row) => row.name).filter(Boolean),
    "Income",
    "Transfers",
    UNCATEGORIZED_CATEGORY,
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
      validCategories.has(normalizedTransactionCategory)
        ? normalizedTransactionCategory
        : UNCATEGORIZED_CATEGORY,
      "user",
      100
    );
  }

  if (lockedManual) {
    return buildCategorizedTransaction(
      transaction,
      validCategories.has(normalizedTransactionCategory)
        ? normalizedTransactionCategory
        : UNCATEGORIZED_CATEGORY,
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

  return buildCategorizedTransaction(transaction, UNCATEGORIZED_CATEGORY, "ai", 42);
}

export function categorizeTransactions(transactions, options) {
  const normalizedOptions = {
    ...options,
    merchantCategoryRules: normalizeMerchantCategoryRules(options?.merchantCategoryRules),
  };
  return transactions.map((transaction) => categorizeTransaction(transaction, normalizedOptions));
}

export function buildMerchantCategoryRules(currentRules, merchant, category) {
  const normalizedMerchant = normalizeMerchantName(merchant);
  if (!normalizedMerchant || !category) return currentRules;

  return {
    ...currentRules,
    [normalizedMerchant]: category,
  };
}

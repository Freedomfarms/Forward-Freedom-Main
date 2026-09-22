import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

// Learned merchant-category rules must survive per-swipe descriptor noise.
// Bank feeds report the same merchant with a different date, reference number
// and card suffix on every visit ("PURCHASE AUTHORIZED ON 08/24 P&W
// MIDDLETOWN CT S466236607143302 CARD 6709"), so the rule key has to reduce
// to the stable merchant core or the user has to re-teach the same lunch spot
// on every transaction. Loaded through Vite because the module's import chain
// includes JSX files node cannot parse directly.

async function loadCategorizationModule() {
  const server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });

  try {
    return await server.ssrLoadModule("/src/utils/transactionCategorization.js");
  } finally {
    await server.close();
  }
}

const modulePromise = loadCategorizationModule();

const BUDGET_ROWS = [{ name: "Lunch", transactionCategories: [] }];

const SWIPE_ONE =
  "PURCHASE AUTHORIZED ON 08/24 P&W MIDDLETOWN MIDDLETOWN CT S466236607143302 CARD 6709";
const SWIPE_TWO =
  "PURCHASE AUTHORIZED ON 08/25 P&W MIDDLETOWN MIDDLETOWN CT S386236557668163 CARD 6709";

function plaidTransaction(merchant, overrides = {}) {
  return {
    id: `tx-${Math.random().toString(36).slice(2)}`,
    source: "plaid",
    merchant,
    category: "",
    amount: -12.5,
    date: "August 25, 2026",
    ...overrides,
  };
}

test("descriptors differing only in swipe metadata normalize to the same key", async () => {
  const { normalizeMerchantName } = await modulePromise;

  const keyOne = normalizeMerchantName(SWIPE_ONE);
  const keyTwo = normalizeMerchantName(SWIPE_TWO);

  assert.equal(keyOne, "P W MIDDLETOWN MIDDLETOWN CT");
  assert.equal(keyOne, keyTwo);
});

test("short numbers that are part of the merchant identity are kept", async () => {
  const { normalizeMerchantName } = await modulePromise;

  assert.equal(normalizeMerchantName("FOREVER 21 #0345 SPRINGFIELD MA"), "FOREVER 21 SPRINGFIELD MA");
  assert.equal(normalizeMerchantName("7-ELEVEN 32734"), "7 ELEVEN");
});

test("an all-noise descriptor still produces a non-empty deterministic key", async () => {
  const { normalizeMerchantName } = await modulePromise;

  const key = normalizeMerchantName("S466236607143302 08/24");
  assert.equal(key.length > 0, true);
  assert.equal(key, normalizeMerchantName("S466236607143302 08/24"));
});

test("normalization is stable when re-run on its own output", async () => {
  const { normalizeMerchantName } = await modulePromise;

  const once = normalizeMerchantName(SWIPE_ONE);
  assert.equal(normalizeMerchantName(once), once);
});

test("categorizing one swipe teaches all future swipes at the same merchant", async () => {
  const { buildMerchantCategoryRules, categorizeTransactions } = await modulePromise;

  // User picks "Lunch" on the first transaction (updateTransactionCategory
  // records the rule through buildMerchantCategoryRules).
  const rules = buildMerchantCategoryRules({}, SWIPE_ONE, "Lunch");

  // The next sync delivers the same restaurant with a new reference number.
  const [categorized] = categorizeTransactions([plaidTransaction(SWIPE_TWO)], {
    budgetRows: BUDGET_ROWS,
    merchantCategoryRules: rules,
  });

  assert.equal(categorized.category, "Lunch");
  assert.equal(categorized.categorySource, "learned");
  assert.equal(categorized.needsReview, false);
});

test("rules stored under old noisy keys are migrated at consumption time", async () => {
  const { categorizeTransactions } = await modulePromise;

  // Key shape produced by the pre-migration normalizer: punctuation stripped,
  // generic words removed, but date / reference / card suffix retained.
  const legacyRules = {
    "AUTHORIZED ON 08 24 P W MIDDLETOWN MIDDLETOWN CT S466236607143302 6709": "Lunch",
  };

  const [categorized] = categorizeTransactions([plaidTransaction(SWIPE_TWO)], {
    budgetRows: BUDGET_ROWS,
    merchantCategoryRules: legacyRules,
  });

  assert.equal(categorized.category, "Lunch");
  assert.equal(categorized.categorySource, "learned");
});

test("user-confirmed transactions stay locked regardless of learned rules", async () => {
  const { buildMerchantCategoryRules, categorizeTransactions } = await modulePromise;

  const rules = buildMerchantCategoryRules({}, SWIPE_ONE, "Lunch");
  const [categorized] = categorizeTransactions(
    [plaidTransaction(SWIPE_TWO, { category: "Travel", categorySource: "user" })],
    { budgetRows: [{ name: "Travel", transactionCategories: [] }], merchantCategoryRules: rules }
  );

  assert.equal(categorized.category, "Travel");
  assert.equal(categorized.categorySource, "user");
  assert.equal(categorized.categoryConfidence, 100);
});

import { calculateCryptoBalance } from "./cryptoPricing.js";

export const ACCOUNT_TYPES = [
  "Checking",
  "Savings",
  "Credit Card",
  "Investment",
  "Crypto",
  "Precious Metals",
  "Real Estate",
  "Retirement",
  "Mortgages / Loans",
  "Manual Cash",
];

export const ACCOUNT_GROUPS = [
  { title: "Checking", filter: (account) => account.type === "Checking" },
  { title: "Savings", filter: (account) => account.type === "Savings" },
  { title: "Investments", filter: (account) => account.type === "Investment" },
  { title: "Crypto", filter: (account) => account.type === "Crypto" },
  { title: "Precious Metals", filter: (account) => account.type === "Precious Metals" },
  { title: "Real Estate", filter: (account) => account.type === "Real Estate" },
  { title: "Retirement", filter: (account) => account.type === "Retirement" },
  { title: "Credit Cards", filter: (account) => account.type === "Credit Card" },
  { title: "Mortgages / Loans", filter: (account) => account.type === "Mortgages / Loans" },
  { title: "Other / Cash", filter: (account) => account.type === "Manual Cash" },
];

export const TRANSACTIONAL_ACCOUNT_TYPES = new Set([
  "Checking",
  "Savings",
  "Credit Card",
  "Manual Cash",
]);

export const PRECIOUS_METAL_TYPES = ["Gold", "Silver", "Platinum", "Palladium", "Custom"];
export const PRECIOUS_METAL_UNITS = ["oz", "g"];

function roundCurrency(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function roundRate(value, digits = 8) {
  return Number((Number(value) || 0).toFixed(digits));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function generateAccountId(prefix = "account") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function calculatePreciousMetalsBalance(quantity, pricePerUnit) {
  return roundCurrency((Number(quantity) || 0) * (Number(pricePerUnit) || 0));
}

export function calculateRealEstateEquity(marketValue, linkedLoanBalance) {
  return roundCurrency((Number(marketValue) || 0) - Math.abs(Number(linkedLoanBalance) || 0));
}

export function accountSupportsTransactions(account) {
  return TRANSACTIONAL_ACCOUNT_TYPES.has(account?.type);
}

export function isPlaidLinkedAccount(account) {
  return Boolean(
    account && (account.syncSource === "Plaid" || account.plaidAccountId || account.plaidItemId)
  );
}

// Plaid-linked accounts get their balance from the live bank sync. Applying a
// manual-transaction delta to them creates a permanent discrepancy: the next
// sync overwrites the balance while the manual transaction stays in the
// ledger, so history and balance never reconcile again.
export function accountSupportsManualTransactions(account) {
  return accountSupportsTransactions(account) && !isPlaidLinkedAccount(account);
}

export function normalizeAccount(account, index = 0) {
  const baseAccount = {
    ...account,
    id: account.id || `account-${slugify(account.name || account.type || "item")}-${index}`,
    name: account.name || `Account ${index + 1}`,
    nickname: typeof account.nickname === "string" && account.nickname.trim() ? account.nickname.trim() : null,
    type: account.type || "Checking",
    institution: account.institution || "Manual",
    status: account.status || "Manual",
    balance: roundCurrency(account.balance),
  };

  if (baseAccount.type === "Crypto") {
    const quantity = roundRate(account.quantity);
    const lastPriceUsd = roundRate(account.lastPriceUsd);
    return {
      ...baseAccount,
      quantity,
      cryptoAssetId: account.cryptoAssetId || "",
      cryptoName: account.cryptoName || "",
      cryptoSymbol: account.cryptoSymbol || "",
      cryptoThumb: account.cryptoThumb || "",
      lastPriceUsd,
      lastPriceUpdatedAt: Number(account.lastPriceUpdatedAt) || null,
      priceSource: account.priceSource || "CoinGecko",
      balance: calculateCryptoBalance(quantity, lastPriceUsd),
    };
  }

  if (baseAccount.type === "Precious Metals") {
    const quantity = roundRate(account.quantity);
    const pricePerUnit = roundCurrency(account.pricePerUnit);
    return {
      ...baseAccount,
      metalType: account.metalType || "Gold",
      metalCustomName: account.metalCustomName || "",
      metalUnit: account.metalUnit || "oz",
      quantity,
      pricePerUnit,
      valuationSource: account.valuationSource || "Manual",
      lastValuedAt: Number(account.lastValuedAt) || Date.now(),
      balance: calculatePreciousMetalsBalance(quantity, pricePerUnit),
    };
  }

  if (baseAccount.type === "Real Estate") {
    const propertyMarketValue = roundCurrency(account.propertyMarketValue);
    return {
      ...baseAccount,
      propertyAddress: account.propertyAddress || "",
      linkedLoanId: account.linkedLoanId || "",
      propertyType: account.propertyType || "Property",
      propertyMarketValue,
      equitySource: account.equitySource || (propertyMarketValue > 0 ? "Derived" : "Manual"),
      lastValuedAt: Number(account.lastValuedAt) || Date.now(),
    };
  }

  if (baseAccount.type === "Mortgages / Loans") {
    return {
      ...baseAccount,
      linkedPropertyId: account.linkedPropertyId || "",
      loanCategory: account.loanCategory || "Mortgage",
      interestRate: account.interestRate || "",
      monthlyPayment: account.monthlyPayment || "",
    };
  }

  return baseAccount;
}

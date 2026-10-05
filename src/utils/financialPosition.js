// Shared Freedom Financial position math.
//
// The dashboard and CHIEF both call these functions. Balances stay snapshots.
// Net worth is the real sum. A display floor belongs in the UI, not here.
// Loan kinds stay the stored loanCategory string. Asset symbols stay the
// stored cryptoSymbol / metalType. Nothing in this module names a ticker.

import {
  calculatePreciousMetalsBalance,
  calculateRealEstateEquity,
} from "./accounts.js";
import { calculateCryptoBalance } from "./cryptoPricing.js";
import { addMoney, roundMoney, subtractMoney, sumMoney } from "./money.js";
import { computeTrueCash } from "./reserves.js";

const LIQUID_ACCOUNT_TYPES = new Set(["Checking", "Savings", "Manual Cash"]);

const SEMANTIC_BY_TYPE = Object.freeze({
  Checking: "cash",
  Savings: "cash",
  "Manual Cash": "cash",
  Investment: "investment",
  Retirement: "retirement",
  Crypto: "crypto",
  "Precious Metals": "metal",
  "Real Estate": "real_estate",
  "Credit Card": "credit_card",
  "Mortgages / Loans": "loan",
});

const NET_WORTH_CATEGORIES = new Set([
  "cash",
  "investment",
  "retirement",
  "crypto",
  "metal",
  "real_estate",
  "credit_card",
]);

const ALLOCATION_SLICES = [
  ["Investments", "Investment"],
  ["Crypto", "Crypto"],
  ["Precious Metals", "Precious Metals"],
  ["Real Estate", "Real Estate"],
  ["Retirement", "Retirement"],
];

const HOLDING_SYMBOL = /^[A-Za-z0-9]{1,12}$/;
const HOLDING_ASSET = /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,40}$/;
const METAL_NAME = /^[A-Za-z0-9][A-Za-z0-9 .+-]{0,40}$/;
const METAL_UNITS = new Set(["oz", "ozt", "g", "kg", "lb"]);

export function semanticCategoryForAccountType(type) {
  return SEMANTIC_BY_TYPE[type] || "other";
}

function text(value, max = 120) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.length > max) return "";
  return trimmed;
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function accountIdOf(account, index) {
  const id = text(account?.id, 160);
  return id || `acct-${index}`;
}

function sumType(accounts, type) {
  return sumMoney(
    accounts.filter((account) => account.type === type),
    (account) => account.balance
  );
}

function idsOf(accounts) {
  return accounts.map((account) => account.id);
}

function shareOf(amount, netWorth) {
  if (!(netWorth > 0)) return null;
  return Math.round((amount / netWorth) * 1000) / 10;
}

function owed(balance) {
  const amount = roundMoney(balance);
  return amount < 0 ? roundMoney(Math.abs(amount)) : 0;
}

/**
 * Sign split used by the Accounts hero. Positive balances are assets.
 * Negative balances are liabilities. This is not net worth: a linked loan
 * remains its own negative balance after the property has already become equity.
 */
export function signedBalanceTotals(accounts = []) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const assetRows = rows.filter((account) => (Number(account?.balance) || 0) > 0);
  const liabilityRows = rows.filter((account) => (Number(account?.balance) || 0) < 0);
  const totalAssets = sumMoney(assetRows, (account) => account.balance);
  const totalLiabilities = Math.abs(
    sumMoney(liabilityRows, (account) => account.balance)
  );
  return {
    totalAssets,
    totalLiabilities,
    netBalance: subtractMoney(totalAssets, totalLiabilities),
    assetAccountIds: assetRows.map((account) => account.id).filter(Boolean),
    liabilityAccountIds: liabilityRows.map((account) => account.id).filter(Boolean),
  };
}

function holdingFor(account) {
  if (account.semanticCategory === "crypto") {
    const symbol = HOLDING_SYMBOL.test(account.cryptoSymbol) ? account.cryptoSymbol.toUpperCase() : "";
    const asset = HOLDING_ASSET.test(account.cryptoName) ? account.cryptoName : "";
    if (!symbol && !asset) return null;
    return {
      accountId: account.id,
      type: "Crypto",
      semanticCategory: "crypto",
      symbol,
      asset,
      cryptoAssetId: account.cryptoAssetId,
      quantity: account.quantity,
      unit: symbol || "units",
      balance: account.balance,
    };
  }
  if (account.semanticCategory === "metal") {
    const metal = METAL_NAME.test(account.metalType) ? account.metalType : "";
    if (!metal) return null;
    const unit = METAL_UNITS.has(account.metalUnit) ? account.metalUnit : "oz";
    return {
      accountId: account.id,
      type: "Precious Metals",
      semanticCategory: "metal",
      metal,
      metalCustomName: account.metalCustomName,
      quantity: account.quantity,
      unit,
      pricePerUnit: account.pricePerUnit,
      balance: account.balance,
    };
  }
  return null;
}

function blankIdentity() {
  return {
    quantity: null,
    cryptoSymbol: "",
    cryptoName: "",
    cryptoAssetId: "",
    metalType: "",
    metalCustomName: "",
    metalUnit: "",
    pricePerUnit: null,
    loanCategory: "",
    linkedLoanId: "",
    linkedPropertyId: "",
    propertyMarketValue: 0,
    includedInPropertyEquity: false,
    securityHoldings: false,
  };
}

/**
 * One normalized account. Equity is applied once, from market value and the
 * linked loan balance, and the loan is flagged so later totals can see the link.
 * Investment and retirement accounts stay account-level: there is no lot source.
 */
export function normalizePositionAccounts(accounts = []) {
  const source = Array.isArray(accounts) ? accounts : [];
  const prepared = source.map((account, index) => {
    const type = typeof account?.type === "string" && account.type ? account.type : "Checking";
    const semanticCategory = semanticCategoryForAccountType(type);
    let balance = roundMoney(account?.balance);
    const identity = blankIdentity();

    if (semanticCategory === "crypto") {
      identity.quantity = finiteOrNull(account?.quantity);
      identity.cryptoSymbol = text(account?.cryptoSymbol, 12);
      identity.cryptoName = text(account?.cryptoName, 80);
      identity.cryptoAssetId = text(account?.cryptoAssetId, 80);
      if (account?.quantity != null || account?.lastPriceUsd != null) {
        balance = calculateCryptoBalance(account.quantity, account.lastPriceUsd);
      }
    } else if (semanticCategory === "metal") {
      identity.quantity = finiteOrNull(account?.quantity);
      identity.metalType = text(account?.metalType, 40);
      identity.metalCustomName = text(account?.metalCustomName, 80);
      identity.metalUnit = text(account?.metalUnit, 8);
      identity.pricePerUnit = finiteOrNull(account?.pricePerUnit);
      if (account?.quantity != null || account?.pricePerUnit != null) {
        balance = calculatePreciousMetalsBalance(account.quantity, account.pricePerUnit);
      }
    } else if (semanticCategory === "real_estate") {
      identity.propertyMarketValue = roundMoney(account?.propertyMarketValue);
      identity.linkedLoanId = text(account?.linkedLoanId, 160);
    } else if (semanticCategory === "loan") {
      identity.loanCategory = text(account?.loanCategory, 80);
      identity.linkedPropertyId = text(account?.linkedPropertyId, 160);
    } else if (semanticCategory === "investment" || semanticCategory === "retirement") {
      identity.securityHoldings = false;
    }

    return {
      id: accountIdOf(account, index),
      name: text(account?.name, 120),
      type,
      semanticCategory,
      subtype: text(account?.plaidSubtype || account?.subtype, 80),
      balance,
      source: account?.syncSource === "Plaid" || account?.plaidAccountId ? "plaid" : "manual",
      ...identity,
    };
  });

  const byId = new Map(prepared.map((account) => [account.id, account]));
  return prepared.map((account) => {
    if (account.semanticCategory !== "real_estate") return account;
    if (!account.linkedLoanId || !account.propertyMarketValue) return account;
    const linkedLoan = byId.get(account.linkedLoanId);
    if (!linkedLoan) return account;
    linkedLoan.includedInPropertyEquity = true;
    if (!linkedLoan.linkedPropertyId) linkedLoan.linkedPropertyId = account.id;
    return {
      ...account,
      balance: calculateRealEstateEquity(account.propertyMarketValue, linkedLoan.balance),
      equityDerived: true,
    };
  });
}

function loansOf(accounts) {
  return accounts
    .filter((account) => account.semanticCategory === "loan")
    .map((account) => ({
      accountId: account.id,
      name: account.name,
      loanCategory: account.loanCategory || "Loan",
      balance: account.balance,
      amountOwed: owed(account.balance),
      linkedPropertyId: account.linkedPropertyId,
      includedInPropertyEquity: account.includedInPropertyEquity,
    }));
}

function debtAllocationOf(creditCardDebt, creditCardAccountIds, loans) {
  const slices = [];
  if (creditCardAccountIds.length) {
    slices.push({
      category: "Credit Card",
      amount: creditCardDebt,
      accountIds: creditCardAccountIds,
    });
  }
  const groups = new Map();
  for (const loan of loans) {
    const category = loan.loanCategory || "Loan";
    const existing = groups.get(category) || { category, amount: 0, accountIds: [] };
    existing.amount = addMoney(existing.amount, loan.amountOwed);
    existing.accountIds.push(loan.accountId);
    groups.set(category, existing);
  }
  return [...slices, ...groups.values()];
}

/**
 * Current-position aggregates. `reservesBalance` is optional and comes from
 * the reserve rows; pass 0 when the ledger that feeds reserves is unavailable
 * and leave the caller to say so. This function does not read transactions.
 */
export function deriveFinancialPosition(accounts = [], { reservesBalance = 0 } = {}) {
  const normalized = normalizePositionAccounts(accounts);
  const liquidAccounts = normalized.filter((account) => LIQUID_ACCOUNT_TYPES.has(account.type));
  const creditCards = normalized.filter((account) => account.type === "Credit Card");
  const liquidCash = sumMoney(liquidAccounts, (account) => account.balance);
  const creditCardNetBalance = sumMoney(creditCards, (account) => account.balance);
  const creditCardDebt = Math.max(0, -creditCardNetBalance);
  const reserves = roundMoney(reservesBalance);
  const grossTrueCash = subtractMoney(liquidCash, creditCardDebt);
  const trueCash = computeTrueCash({
    liquidCash,
    creditCardDebt,
    reservesBalance: reserves,
  });

  const allocationAmounts = ALLOCATION_SLICES.map(([name, type]) => {
    const rows = normalized.filter((account) => account.type === type);
    return { name, type, amount: sumType(normalized, type), accountIds: idsOf(rows) };
  });
  const netWorth = addMoney(grossTrueCash, ...allocationAmounts.map((slice) => slice.amount));
  const netWorthAccounts = normalized.filter((account) =>
    NET_WORTH_CATEGORIES.has(account.semanticCategory)
  );
  const allocation = [
    {
      name: "True Cash",
      amount: grossTrueCash,
      share: shareOf(grossTrueCash, netWorth),
      accountIds: [...idsOf(liquidAccounts), ...idsOf(creditCards)],
    },
    ...allocationAmounts.map((slice) => ({
      name: slice.name,
      amount: slice.amount,
      share: shareOf(slice.amount, netWorth),
      accountIds: slice.accountIds,
    })),
  ];

  const loans = loansOf(normalized);
  const loanDebt = sumMoney(loans, (loan) => loan.amountOwed);
  const signed = signedBalanceTotals(normalized);
  const creditCardAccountIds = idsOf(creditCards);
  const loanAccountIds = loans.map((loan) => loan.accountId);

  const balancesByType = [...new Map(
    normalized.map((account) => [account.type, null])
  ).keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((accountType) => {
      const rows = normalized.filter((account) => account.type === accountType);
      return {
        accountType,
        totalBalance: sumMoney(rows, (account) => account.balance),
        accountCount: rows.length,
        accountIds: idsOf(rows),
      };
    });

  return {
    accounts: normalized,
    holdings: normalized.map(holdingFor).filter(Boolean),
    loans,
    debtAllocation: debtAllocationOf(creditCardDebt, creditCardAccountIds, loans),
    allocation,
    balancesByType,
    position: {
      liquidCash,
      creditCardDebt,
      reservesBalance: reserves,
      reservesOvercommitted: reserves > liquidCash,
      grossTrueCash,
      trueCash,
      netWorth,
    },
    totals: {
      totalAssets: signed.totalAssets,
      totalLiabilities: signed.totalLiabilities,
      loanDebt,
      totalDebt: addMoney(creditCardDebt, loanDebt),
    },
    reconciliation: {
      liquidCash: { amount: liquidCash, accountIds: idsOf(liquidAccounts) },
      creditCardDebt: { amount: creditCardDebt, accountIds: creditCardAccountIds },
      loanDebt: { amount: loanDebt, accountIds: loanAccountIds },
      totalDebt: {
        amount: addMoney(creditCardDebt, loanDebt),
        accountIds: [...creditCardAccountIds, ...loanAccountIds],
      },
      netWorth: { amount: netWorth, accountIds: idsOf(netWorthAccounts) },
      totalAssets: { amount: signed.totalAssets, accountIds: signed.assetAccountIds },
      totalLiabilities: {
        amount: signed.totalLiabilities,
        accountIds: signed.liabilityAccountIds,
      },
    },
  };
}

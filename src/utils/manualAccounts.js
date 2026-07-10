import { normalizeAccount } from "./accounts.js";
import { roundMoney as roundCurrency } from "./money.js";

export function buildManualAccountRecord(
  {
    name,
    type,
    institution,
    balance,
    quantity,
    metalType,
    metalCustomName,
    metalUnit,
    pricePerUnit,
    valuationSource,
    lastValuedAt,
    propertyAddress,
    propertyType,
    propertyMarketValue,
    equitySource,
    linkedLoanId,
    linkedPropertyId,
    loanCategory,
    interestRate,
    monthlyPayment,
    cryptoAssetId,
    cryptoName,
    cryptoSymbol,
    cryptoThumb,
    lastPriceUsd,
    lastPriceUpdatedAt,
    priceSource,
  },
  { accountId, timestamp = Date.now() } = {}
) {
  const currentTimestamp = Number(timestamp) || Date.now();
  const manualAccount = {
    id: accountId,
    name,
    type,
    institution: institution || "Manual",
    balance: roundCurrency(balance),
    status: "Manual",
  };

  if (type === "Crypto" && cryptoAssetId) {
    return {
      ...manualAccount,
      quantity: Number(quantity) || 0,
      cryptoAssetId,
      cryptoName,
      cryptoSymbol,
      cryptoThumb,
      lastPriceUsd: Number(lastPriceUsd) || 0,
      lastPriceUpdatedAt: Number(lastPriceUpdatedAt) || currentTimestamp,
      priceSource: priceSource || "CoinGecko",
    };
  }

  if (type === "Precious Metals") {
    return {
      ...manualAccount,
      quantity: Number(quantity) || 0,
      metalType: metalType || "Gold",
      metalCustomName: metalCustomName || "",
      metalUnit: metalUnit || "oz",
      pricePerUnit: Number(pricePerUnit) || 0,
      valuationSource: valuationSource || "Manual",
      lastValuedAt: Number(lastValuedAt) || currentTimestamp,
    };
  }

  if (type === "Real Estate") {
    return {
      ...manualAccount,
      propertyAddress: propertyAddress || "",
      propertyType: propertyType || "",
      propertyMarketValue: Number(propertyMarketValue) || 0,
      equitySource: equitySource || "Manual",
      lastValuedAt: currentTimestamp,
      linkedLoanId: linkedLoanId || "",
    };
  }

  if (type === "Mortgages / Loans") {
    return {
      ...manualAccount,
      linkedPropertyId: linkedPropertyId || "",
      loanCategory: loanCategory || "",
      interestRate: interestRate || "",
      monthlyPayment: monthlyPayment || "",
    };
  }

  return manualAccount;
}

export function createManualAccount(accountInput, index, options) {
  return normalizeAccount(buildManualAccountRecord(accountInput, options), index);
}

export function updateManualAccountInUser(user, accountId, accountInput, options) {
  const accountIndex = user.accounts.findIndex((account) => account.id === accountId);
  if (accountIndex < 0) return user;

  const existingAccount = user.accounts[accountIndex];
  if (existingAccount.plaidItemId) return user;

  const nextAccount = normalizeAccount(
    buildManualAccountRecord(accountInput, {
      ...options,
      accountId: existingAccount.id,
    }),
    accountIndex
  );
  const previousName = existingAccount.name;
  const nextName = nextAccount.name;
  const nameChanged = previousName !== nextName;

  return {
    ...user,
    accounts: user.accounts.map((account, index) => (index === accountIndex ? nextAccount : account)),
    transactions: nameChanged
      ? user.transactions.map((transaction) =>
          transaction.account === previousName ? { ...transaction, account: nextName } : transaction
        )
      : user.transactions,
    subscriptions: user.subscriptions.map((subscription) => {
      if (subscription.accountId === existingAccount.id) {
        return {
          ...subscription,
          account: nextName,
          accountId: existingAccount.id,
        };
      }

      if (nameChanged && subscription.account === previousName) {
        return {
          ...subscription,
          account: nextName,
        };
      }

      return subscription;
    }),
    selectedAccount: user.selectedAccount === previousName ? nextName : user.selectedAccount,
  };
}

import { fromCents, toCents } from "./money.js";

export function isSpendTransaction(transaction) {
  const amount = Number(transaction?.amount) || 0;
  if (amount >= 0) return false;
  return String(transaction?.category || "").trim().toLowerCase() !== "transfers";
}

export function sumSpendTransactions(transactions) {
  return fromCents(
    transactions.reduce((cents, transaction) => {
      return isSpendTransaction(transaction)
        ? cents + Math.abs(toCents(transaction?.amount))
        : cents;
    }, 0)
  );
}

export function isSpendTransaction(transaction) {
  const amount = Number(transaction?.amount) || 0;
  if (amount >= 0) return false;
  return String(transaction?.category || "").trim().toLowerCase() !== "transfers";
}

export function sumSpendTransactions(transactions) {
  return transactions.reduce((sum, transaction) => {
    const amount = Number(transaction?.amount) || 0;
    return isSpendTransaction(transaction) ? sum + Math.abs(amount) : sum;
  }, 0);
}

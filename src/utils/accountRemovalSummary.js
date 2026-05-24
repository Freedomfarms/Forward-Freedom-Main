export function buildAccountRemovalSummary(
  deleteTarget,
  accounts,
  transactions,
  subscriptions,
  linkedPlaidItems
) {
  const items = linkedPlaidItems || [];
  const deleteTargetPlaidItem = deleteTarget?.plaidItemId
    ? items.find((item) => item.itemId === deleteTarget.plaidItemId) || null
    : null;
  const deleteTargetLinkedAccounts = deleteTargetPlaidItem
    ? accounts.filter((account) => account.plaidItemId === deleteTargetPlaidItem.itemId)
    : deleteTarget
      ? [deleteTarget]
      : [];
  const deleteTargetLinkedAccountNames = new Set(
    deleteTargetLinkedAccounts.map((account) => account.name)
  );
  const deleteTargetTransactionCount = deleteTarget
    ? transactions.filter((transaction) =>
        deleteTarget.plaidItemId
          ? transaction.source === "plaid" && deleteTargetLinkedAccountNames.has(transaction.account)
          : transaction.account === deleteTarget.name
      ).length
    : 0;
  const deleteTargetSubscriptionCount = deleteTarget
    ? subscriptions.filter((subscription) =>
        deleteTarget.plaidItemId
          ? deleteTargetLinkedAccountNames.has(subscription.account)
          : subscription.account === deleteTarget.name || subscription.accountId === deleteTarget.id
      ).length
    : 0;

  return {
    deleteTargetPlaidItem,
    deleteTargetLinkedAccounts,
    deleteTargetTransactionCount,
    deleteTargetSubscriptionCount,
  };
}

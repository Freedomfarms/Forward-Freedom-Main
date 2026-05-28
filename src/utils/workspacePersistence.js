function isLinkedPlaidAccount(account) {
  if (!account || typeof account !== "object") return false;

  return Boolean(
    account.syncSource === "Plaid" ||
      account.plaidAccountId ||
      account.plaidItemId ||
      account.status === "Synced"
  );
}

function isPlaidBackedTransaction(transaction, linkedAccountNames) {
  if (!transaction || typeof transaction !== "object") return false;

  return Boolean(
    transaction.source === "plaid" ||
      transaction.syncSource === "Plaid" ||
      linkedAccountNames.has(transaction.account)
  );
}

function sanitizePlaidItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .filter((item) => item && typeof item === "object" && item.itemId)
    .map((item) => ({
      itemId: String(item.itemId),
      institutionName: item.institutionName || "Plaid Linked Institution",
      accountIds: Array.isArray(item.accountIds) ? item.accountIds.filter(Boolean) : [],
      lastSyncAt: item.lastSyncAt || null,
      status: item.status === "requires_attention" ? "requires_attention" : "connected",
    }));
}

export function sanitizeWorkspaceStateForPersistence(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return state;
  }

  const users = Array.isArray(state.users)
    ? state.users.map((user) => {
        const accounts = Array.isArray(user?.accounts) ? user.accounts : [];
        const removedPlaidAccountNames = new Set(
          accounts.filter(isLinkedPlaidAccount).map((account) => account.name).filter(Boolean)
        );
        const retainedAccounts = accounts.filter((account) => !isLinkedPlaidAccount(account));
        const retainedTransactions = Array.isArray(user?.transactions)
          ? user.transactions.filter(
              (transaction) => !isPlaidBackedTransaction(transaction, removedPlaidAccountNames)
            )
          : [];
        const selectedAccount = removedPlaidAccountNames.has(user?.selectedAccount)
          ? null
          : user?.selectedAccount || null;

        return {
          ...user,
          accounts: retainedAccounts,
          transactions: retainedTransactions,
          plaidItems: sanitizePlaidItems(user?.plaidItems),
          selectedAccount,
        };
      })
    : state.users;

  return {
    ...state,
    users,
  };
}

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

const SENSITIVE_WORKSPACE_FIELDS = new Set([
  "accessToken",
  "accessTokenCiphertext",
  "plaidMask",
  "publicToken",
  "raw",
]);

function omitSensitiveWorkspaceFields(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;

  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !SENSITIVE_WORKSPACE_FIELDS.has(key))
  );
}

function sanitizeAccountForPersistence(account) {
  return omitSensitiveWorkspaceFields(account);
}

function sanitizeTransactionForPersistence(transaction) {
  return omitSensitiveWorkspaceFields(transaction);
}

export function sanitizeWorkspaceStateForPersistence(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return state;
  }

  const users = Array.isArray(state.users)
    ? state.users.map((user) => {
        const accounts = Array.isArray(user?.accounts) ? user.accounts : [];
        const retainedTransactions = Array.isArray(user?.transactions)
          ? user.transactions.map(sanitizeTransactionForPersistence)
          : [];

        return {
          ...user,
          accounts: accounts.map(sanitizeAccountForPersistence),
          transactions: retainedTransactions,
          plaidItems: sanitizePlaidItems(user?.plaidItems),
          selectedAccount: user?.selectedAccount || null,
        };
      })
    : state.users;

  return {
    ...state,
    users,
  };
}

export function sanitizeWorkspaceStateForBrowserCache(state) {
  const sanitized = sanitizeWorkspaceStateForPersistence(state);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return sanitized;
  }

  if (!Array.isArray(sanitized.users)) {
    return sanitized;
  }

  return {
    ...sanitized,
    users: sanitized.users.map((user) => ({
      ...user,
      transactions: [],
      accounts: Array.isArray(user?.accounts)
        ? user.accounts.filter((account) => account?.syncSource !== "Plaid")
        : [],
      plaidItems: [],
    })),
  };
}

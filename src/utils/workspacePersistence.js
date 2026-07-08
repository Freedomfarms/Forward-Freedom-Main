// Plaid-derived financial data (accounts, balances, transactions, and the Plaid
// item list) is NEVER persisted in the workspace snapshot. It lives only in the
// encrypted normalized tables, which are the single source of truth, and the
// client reloads it from /api/plaid/sync. This prevents duplicate plaintext
// copies of financial data from accumulating in the snapshot blob.
function isPlaidDerivedAccount(account) {
  return Boolean(
    account &&
      (account.syncSource === "Plaid" || account.plaidAccountId || account.plaidItemId)
  );
}

function isPlaidDerivedTransaction(transaction) {
  return Boolean(
    transaction &&
      (transaction.source === "plaid" ||
        transaction.syncSource === "Plaid" ||
        transaction.plaidTransactionId)
  );
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
        const transactions = Array.isArray(user?.transactions) ? user.transactions : [];

        // Keep only manual (non-Plaid) accounts/transactions. Plaid-derived
        // financial data is loaded from the encrypted normalized tables.
        const manualAccounts = accounts
          .filter((account) => !isPlaidDerivedAccount(account))
          .map(sanitizeAccountForPersistence);
        const manualTransactions = transactions
          .filter((transaction) => !isPlaidDerivedTransaction(transaction))
          .map(sanitizeTransactionForPersistence);

        return {
          ...user,
          accounts: manualAccounts,
          transactions: manualTransactions,
          plaidItems: [],
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

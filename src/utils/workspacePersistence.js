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

// Structural guardrails for client-submitted workspace state. The snapshot is
// a free-form JSON blob, but a hostile or buggy client must not be able to
// persist a shape that the normalization code (normalizePersistedAppState and
// friends) cannot handle, or the app would crash on every load for that user.
const MAX_WORKSPACE_STATE_DEPTH = 32;
const MAX_WORKSPACE_USER_PROFILES = 50;

function exceedsMaxDepth(value, maxDepth) {
  // Iterative traversal: attacker-controlled nesting must not be able to blow
  // the call stack of the validator itself.
  const stack = [{ node: value, depth: 1 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (depth > maxDepth) return true;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) {
      if (child && typeof child === "object") {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return false;
}

// Returns a human-readable error string when the submitted workspace state is
// structurally unusable, or null when it is acceptable.
export function getWorkspaceStateValidationError(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return "A workspace state object is required.";
  }

  if (Object.hasOwn(state, "users")) {
    if (!Array.isArray(state.users)) {
      return 'Workspace state field "users" must be an array of profile objects.';
    }
    if (state.users.length > MAX_WORKSPACE_USER_PROFILES) {
      return `Workspace state cannot contain more than ${MAX_WORKSPACE_USER_PROFILES} user profiles.`;
    }
    for (const user of state.users) {
      if (!user || typeof user !== "object" || Array.isArray(user)) {
        return 'Every entry in workspace state "users" must be an object.';
      }
    }
  }

  if (
    Object.hasOwn(state, "activeUserId") &&
    state.activeUserId != null &&
    typeof state.activeUserId !== "string"
  ) {
    return 'Workspace state field "activeUserId" must be a string.';
  }

  if (exceedsMaxDepth(state, MAX_WORKSPACE_STATE_DEPTH)) {
    return `Workspace state is nested deeper than ${MAX_WORKSPACE_STATE_DEPTH} levels and cannot be stored.`;
  }

  return null;
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

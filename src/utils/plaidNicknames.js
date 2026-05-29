function normalizeNickname(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizePlaidNicknameMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([accountId, nickname]) => [accountId, normalizeNickname(nickname)])
      .filter(([, nickname]) => Boolean(nickname))
  );
}

export function buildPlaidNicknameMap(accounts = []) {
  if (!Array.isArray(accounts)) return {};

  return Object.fromEntries(
    accounts
      .filter((account) => account?.syncSource === "Plaid" || account?.plaidAccountId)
      .map((account) => [account.plaidAccountId || account.id, normalizeNickname(account.nickname)])
      .filter(([accountId, nickname]) => Boolean(accountId) && Boolean(nickname))
  );
}

export function applyPlaidNicknamesToAccounts(accounts = [], nicknameMap = {}) {
  const normalizedNicknameMap = normalizePlaidNicknameMap(nicknameMap);
  if (!Array.isArray(accounts) || accounts.length === 0) return [];

  return accounts.map((account) => {
    const nickname = normalizedNicknameMap[account?.plaidAccountId || account?.id];
    return nickname ? { ...account, nickname } : account;
  });
}

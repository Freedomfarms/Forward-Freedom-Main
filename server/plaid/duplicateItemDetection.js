function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function buildIncomingAccountFingerprint(account) {
  return [normalizeText(account?.name), normalizeText(account?.subtype || account?.type)].join("|");
}

function buildExistingAccountFingerprint(account) {
  return [normalizeText(account?.name), normalizeText(account?.plaidSubtype || account?.plaidType || account?.type)].join("|");
}

export function detectDuplicatePlaidItem({
  currentItemId = null,
  existingItems = [],
  incomingAccounts = [],
  institutionId = null,
}) {
  if (!institutionId || !Array.isArray(incomingAccounts) || incomingAccounts.length === 0) {
    return { isDuplicate: false, reason: null };
  }

  const comparableItems = existingItems.filter(
    (item) =>
      item &&
      item.itemId &&
      item.itemId !== currentItemId &&
      item.institutionId &&
      item.institutionId === institutionId
  );

  if (!comparableItems.length) {
    return { isDuplicate: false, reason: null };
  }

  const existingAccountIds = new Set();
  const existingFingerprints = new Set();

  for (const item of comparableItems) {
    for (const account of item.accounts || []) {
      if (account?.plaidAccountId) {
        existingAccountIds.add(account.plaidAccountId);
      }
      const fingerprint = buildExistingAccountFingerprint(account);
      if (fingerprint !== "|") {
        existingFingerprints.add(fingerprint);
      }
    }
  }

  const incomingAccountIds = incomingAccounts.map((account) => account?.id).filter(Boolean);
  const matchedIncomingIds = incomingAccountIds.filter((accountId) => existingAccountIds.has(accountId));
  if (matchedIncomingIds.length > 0) {
    return {
      isDuplicate: true,
      reason: "matching_account_id",
      matchedAccountIds: matchedIncomingIds,
    };
  }

  const incomingFingerprints = incomingAccounts
    .map((account) => buildIncomingAccountFingerprint(account))
    .filter((fingerprint) => fingerprint !== "|");
  const matchedFingerprints = incomingFingerprints.filter((fingerprint) =>
    existingFingerprints.has(fingerprint)
  );

  if (incomingFingerprints.length > 0 && matchedFingerprints.length === incomingFingerprints.length) {
    return {
      isDuplicate: true,
      reason: "matching_institution_account_names",
      matchedFingerprints,
    };
  }

  return { isDuplicate: false, reason: null };
}

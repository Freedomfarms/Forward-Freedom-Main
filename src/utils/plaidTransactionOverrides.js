function resolveTransactionOverrideKey(transaction) {
  return transaction?.plaidTransactionId || transaction?.id || null;
}

function normalizeCategory(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeDateNickname(value) {
  if (value === null) return null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizePlaidTransactionOverrideMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, override]) => {
        if (!key || !override || typeof override !== "object" || Array.isArray(override)) {
          return null;
        }

        const normalized = {};
        const category = normalizeCategory(override.category);
        if (category) {
          normalized.category = category;
        }

        if (Object.hasOwn(override, "dateNickname")) {
          normalized.dateNickname = normalizeDateNickname(override.dateNickname);
        }

        return Object.keys(normalized).length > 0 ? [key, normalized] : null;
      })
      .filter(Boolean)
  );
}

export function buildPlaidTransactionOverrideMap(transactions = [], existingOverrides = {}) {
  const next = { ...normalizePlaidTransactionOverrideMap(existingOverrides) };
  if (!Array.isArray(transactions)) return next;

  transactions.forEach((transaction) => {
    if (transaction?.source !== "plaid") return;

    const key = resolveTransactionOverrideKey(transaction);
    if (!key) return;

    const override = { ...(next[key] || {}) };
    let changed = false;

    if (transaction.categorySource === "user") {
      const category = normalizeCategory(transaction.category);
      if (category && override.category !== category) {
        override.category = category;
        changed = true;
      }
    }

    if (typeof transaction.dateNickname === "string" && transaction.dateNickname.trim()) {
      const dateNickname = transaction.dateNickname.trim();
      if (override.dateNickname !== dateNickname) {
        override.dateNickname = dateNickname;
        changed = true;
      }
    }

    if (changed || Object.keys(override).length > 0) {
      next[key] = override;
    }
  });

  return next;
}

export function applyPlaidTransactionOverrides(transactions = [], overrideMap = {}) {
  const normalized = normalizePlaidTransactionOverrideMap(overrideMap);
  if (!Array.isArray(transactions) || transactions.length === 0) return [];
  if (Object.keys(normalized).length === 0) return transactions;

  return transactions.map((transaction) => {
    const key = resolveTransactionOverrideKey(transaction);
    const override = key ? normalized[key] : null;
    if (!override) return transaction;

    let next = transaction;

    if (override.category) {
      next = {
        ...next,
        category: override.category,
        categorySource: "user",
        categoryConfidence: 100,
        needsReview: false,
      };
    }

    if (Object.hasOwn(override, "dateNickname")) {
      const postedDate = next.plaidPostedDate || next.date;
      if (override.dateNickname === null) {
        next = {
          ...next,
          date: postedDate,
          dateNickname: undefined,
          dateNicknameUpdatedAt: undefined,
        };
      } else if (override.dateNickname) {
        next = {
          ...next,
          plaidPostedDate: postedDate,
          date: override.dateNickname,
          dateNickname: override.dateNickname,
        };
      }
    }

    return next;
  });
}

export function upsertPlaidCategoryOverride(currentOverrides, transaction, category) {
  const key = resolveTransactionOverrideKey(transaction);
  const normalizedCategory = normalizeCategory(category);
  if (!key || !normalizedCategory) return normalizePlaidTransactionOverrideMap(currentOverrides);

  const normalized = normalizePlaidTransactionOverrideMap(currentOverrides);
  return {
    ...normalized,
    [key]: {
      ...(normalized[key] || {}),
      category: normalizedCategory,
    },
  };
}

export function upsertPlaidDateNicknameOverride(currentOverrides, transaction, dateNickname) {
  const key = resolveTransactionOverrideKey(transaction);
  if (!key) return normalizePlaidTransactionOverrideMap(currentOverrides);

  const normalized = normalizePlaidTransactionOverrideMap(currentOverrides);
  const existing = normalized[key] || {};

  if (dateNickname === null || dateNickname === undefined || !String(dateNickname).trim()) {
    const nextEntry = { ...existing, dateNickname: null };
    if (!nextEntry.category) {
      const { [key]: removed, ...rest } = normalized;
      return rest;
    }

    return {
      ...normalized,
      [key]: nextEntry,
    };
  }

  return {
    ...normalized,
    [key]: {
      ...existing,
      dateNickname: String(dateNickname).trim(),
    },
  };
}

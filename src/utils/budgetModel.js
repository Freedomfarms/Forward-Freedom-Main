// Budget calendar and category shape. Plain JavaScript so the server can
// import the same definitions the Freedom Financial dashboard uses.
// constants.jsx re-exports these for the client.

export const budgetMonths = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export const budgetMonthNames = {
  Jan: "January",
  Feb: "February",
  Mar: "March",
  Apr: "April",
  May: "May",
  Jun: "June",
  Jul: "July",
  Aug: "August",
  Sep: "September",
  Oct: "October",
  Nov: "November",
  Dec: "December",
};

export const UNCATEGORIZED_CATEGORY = "Uncategorized";

export const LEGACY_UNCATEGORIZED_CATEGORIES = ["Other"];

export function isUncategorizedCategoryName(name) {
  const normalized = String(name || "").trim();
  return (
    normalized === UNCATEGORIZED_CATEGORY || LEGACY_UNCATEGORIZED_CATEGORIES.includes(normalized)
  );
}

export const BUDGET_CATEGORY_TYPES = {
  OPERATING: "O",
  RESERVE: "R",
};

export const DEFAULT_RESERVE_TARGET_MONTHS = 12;

export function normalizeBudgetCategoryType(type) {
  return type === BUDGET_CATEGORY_TYPES.RESERVE
    ? BUDGET_CATEGORY_TYPES.RESERVE
    : BUDGET_CATEGORY_TYPES.OPERATING;
}

/**
 * Ensures a budget row carries the fields the Reserve (preparedness) feature relies on.
 * Operating rows are the default; reserve fields are only meaningful when type === "R".
 */
export function normalizeBudgetRow(row) {
  if (!row || typeof row !== "object") return row;
  const type = normalizeBudgetCategoryType(row.type);
  const normalized = { ...row, type };

  if (type === BUDGET_CATEGORY_TYPES.RESERVE) {
    const targetMonths = Number(row.reserveTargetMonths);
    normalized.reserveTargetMonths =
      Number.isFinite(targetMonths) && targetMonths > 0
        ? targetMonths
        : DEFAULT_RESERVE_TARGET_MONTHS;

    const anchor = row.reserveAnchor;
    const hasValidAnchor =
      anchor &&
      typeof anchor === "object" &&
      budgetMonths.includes(anchor.month) &&
      Number.isFinite(Number(anchor.year));
    normalized.reserveAnchor = hasValidAnchor
      ? { month: anchor.month, year: Number(anchor.year) }
      : null;
  }

  return normalized;
}

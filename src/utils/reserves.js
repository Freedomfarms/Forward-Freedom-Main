import {
  BUDGET_CATEGORY_TYPES,
  DEFAULT_RESERVE_TARGET_MONTHS,
  budgetMonths,
} from "../data/constants.jsx";
import { getCurrentBudgetPeriod } from "./date.js";
import { parseBudgetReviewDate } from "./budgetReview.js";

/**
 * Reserve (preparedness) funds are fundamentally different from operating budgets:
 * the monthly "budget" value is a recurring contribution, not a spending ceiling.
 *
 * Balance = (monthly contribution x active months elapsed since the anchor)
 *           - (net spending categorized to the reserve since the anchor)
 *
 * Per the locked product decisions:
 * - Balances are never capped and contributions never auto-pause (overfunding allowed).
 * - Readiness % is capped at 100 for display, but balance/target remain visible.
 * - Target = monthly contribution x 12 (no override in v1).
 * - Accrual starts at an explicit anchor; history before the anchor is never backfilled.
 * - Refunds (inflows) categorized to the reserve increase the balance.
 */

export function isReserveRow(row) {
  return row?.type === BUDGET_CATEGORY_TYPES.RESERVE;
}

function periodIndex(month, year) {
  const monthIndex = budgetMonths.indexOf(month);
  if (monthIndex < 0) return null;
  return Number(year) * 12 + monthIndex;
}

/**
 * Counts how many contributions have accrued from the anchor period through the
 * "as of" period (inclusive), respecting the reserve's active months.
 */
export function countActiveContributions(anchor, asOf, activeMonths = budgetMonths) {
  const startIndex = periodIndex(anchor?.month, anchor?.year);
  const endIndex = periodIndex(asOf?.month, asOf?.year);
  if (startIndex === null || endIndex === null || endIndex < startIndex) return 0;

  const months = Array.isArray(activeMonths) && activeMonths.length ? activeMonths : budgetMonths;
  let count = 0;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const monthName = budgetMonths[((index % 12) + 12) % 12];
    if (months.includes(monthName)) count += 1;
  }
  return count;
}

const RESERVE_STATUS_BANDS = [
  { key: "fully", label: "Fully Funded", color: "#00f59b", min: 100 },
  { key: "strong", label: "Strong", color: "#38bdf8", min: 75 },
  { key: "building", label: "Building", color: "#ffce4f", min: 50 },
  { key: "critical", label: "Critical", color: "#ff5d7a", min: 0 },
];

// Neutral state for a reserve that has no monthly contribution set yet, so a
// freshly-created fund reads as "not started" rather than a failing Critical/Red.
export const RESERVE_NOT_STARTED = {
  key: "notstarted",
  label: "Not Started",
  color: "#7fa1ca",
  min: 0,
};

const FRC_BANDS = [
  { key: "green", label: "Green", color: "#00f59b", min: 90 },
  { key: "blue", label: "Blue", color: "#38bdf8", min: 75 },
  { key: "yellow", label: "Yellow", color: "#ffce4f", min: 50 },
  { key: "red", label: "Red", color: "#ff5d7a", min: 0 },
];

export function getReserveStatus(ratio) {
  const percent = (Number(ratio) || 0) * 100;
  return (
    RESERVE_STATUS_BANDS.find((band) => percent >= band.min) ||
    RESERVE_STATUS_BANDS[RESERVE_STATUS_BANDS.length - 1]
  );
}

export function getFrcBand(percent) {
  const value = Number(percent) || 0;
  return FRC_BANDS.find((band) => value >= band.min) || FRC_BANDS[FRC_BANDS.length - 1];
}

function buildReserveCategorySet(row) {
  return new Set([row.name, ...(row.transactionCategories || [])].filter(Boolean));
}

/**
 * Builds the preparedness snapshot for a single reserve row as of the given period.
 */
export function buildReserveSnapshot(row, transactions, options = {}) {
  const period = getCurrentBudgetPeriod();
  const asOfMonth = options.asOfMonth || period.month;
  const asOfYear = Number(options.asOfYear) || period.year;
  const asOf = { month: asOfMonth, year: asOfYear };

  const monthlyContribution = Number(row.budget) || 0;
  const targetMonths = Number(row.reserveTargetMonths) || DEFAULT_RESERVE_TARGET_MONTHS;
  const target = monthlyContribution * targetMonths;
  const activeMonths = Array.isArray(row.months) && row.months.length ? row.months : budgetMonths;

  // Default anchor is the "as of" period so a freshly-converted reserve never
  // backfills contributions for months before it existed.
  const anchor =
    row.reserveAnchor && budgetMonths.includes(row.reserveAnchor.month)
      ? { month: row.reserveAnchor.month, year: Number(row.reserveAnchor.year) || asOfYear }
      : asOf;

  const anchorIndex = periodIndex(anchor.month, anchor.year);
  const asOfIndex = periodIndex(asOfMonth, asOfYear);

  const contributions =
    monthlyContribution * countActiveContributions(anchor, asOf, activeMonths);

  const categorySet = buildReserveCategorySet(row);
  const list = Array.isArray(transactions) ? transactions : [];

  let netWithdrawals = 0;
  let deployedThisMonth = 0;
  for (const transaction of list) {
    if (!categorySet.has(transaction.category)) continue;
    const parsed = parseBudgetReviewDate(transaction.date);
    if (!parsed) continue;
    const index = periodIndex(parsed.month, parsed.year);
    if (index === null || index < anchorIndex || index > asOfIndex) continue;

    const amount = Number(transaction.amount) || 0;
    // Spending is a negative amount (outflow) -> increases withdrawals.
    // Refunds are positive (inflow) -> reduce withdrawals (restore the reserve).
    netWithdrawals += -amount;

    if (parsed.month === asOfMonth && parsed.year === asOfYear && amount < 0) {
      deployedThisMonth += Math.abs(amount);
    }
  }

  const balance = Math.max(0, contributions - netWithdrawals);
  const ratio = target > 0 ? balance / target : 0;
  const started = target > 0;
  const status = started ? getReserveStatus(ratio) : RESERVE_NOT_STARTED;
  const readinessPercent = started ? Math.min(100, Math.round(ratio * 100)) : 0;
  const fullyFunded = started && balance >= target;

  return {
    ...row,
    monthlyContribution,
    target,
    targetMonths,
    contributions,
    balance,
    ratio,
    readinessPercent,
    status,
    started,
    fullyFunded,
    deployedThisMonth,
    anchor,
  };
}

/**
 * Spendable True Cash after committed reserves are removed.
 *
 *   True Cash = gross liquid cash - credit card debt - reserves balance
 *
 * Reserve dollars physically remain in the bank (so they still count toward gross
 * cash and net worth) but are committed, so they are removed from spendable cash.
 * The result is intentionally NOT floored: a negative value honestly signals the
 * user has committed more than they currently hold ("overcommitted").
 */
export function computeTrueCash({ liquidCash = 0, creditCardDebt = 0, reservesBalance = 0 } = {}) {
  return (Number(liquidCash) || 0) - (Number(creditCardDebt) || 0) - (Number(reservesBalance) || 0);
}

/**
 * Dollar-weighted Financial Readiness Condition across all reserve funds.
 * FRC = total reserve balances / total reserve targets.
 */
export function buildReserveReadiness(reserveRows, transactions, options = {}) {
  const reserves = (Array.isArray(reserveRows) ? reserveRows : [])
    .filter(isReserveRow)
    .map((row) => buildReserveSnapshot(row, transactions, options));

  const totalBalance = reserves.reduce((sum, reserve) => sum + reserve.balance, 0);
  const totalTarget = reserves.reduce((sum, reserve) => sum + reserve.target, 0);
  const ratio = totalTarget > 0 ? totalBalance / totalTarget : 0;
  const overallPercent = totalTarget > 0 ? Math.min(100, Math.round(ratio * 100)) : 0;

  return {
    reserves,
    count: reserves.length,
    totalBalance,
    totalTarget,
    ratio,
    overallPercent,
    band: getFrcBand(overallPercent),
  };
}

import { budgetMonths } from "../data/constants.jsx";

export function getCurrentTimestamp() {
  return Date.now();
}

export function getCurrentBudgetPeriod(date = new Date()) {
  const monthIndex = date.getMonth();
  return {
    monthIndex,
    month: budgetMonths[monthIndex] || budgetMonths[0],
    year: date.getFullYear(),
  };
}

export function getBudgetPeriodAtOffset(offset = 0, date = new Date()) {
  const nextDate = new Date(date.getFullYear(), date.getMonth() + offset, 1);
  return getCurrentBudgetPeriod(nextDate);
}

export function getIsoDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

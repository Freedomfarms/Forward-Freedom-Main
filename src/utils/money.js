/**
 * Integer-cents money math.
 *
 * IEEE-754 floats cannot represent most decimal fractions exactly
 * (0.1 + 0.2 !== 0.3), so repeated float addition drifts. Every aggregation
 * here converts dollars to integer cents, does the arithmetic on integers,
 * and converts back to dollars exactly once.
 */

export function toCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

export function fromCents(cents) {
  const number = Number(cents);
  if (!Number.isFinite(number)) return 0;
  return number / 100;
}

/** Rounds a dollar amount to exact cents. */
export function roundMoney(value) {
  return fromCents(toCents(value));
}

/** Sums dollar amounts using integer-cents arithmetic. */
export function sumMoney(values, selector = (value) => value) {
  const list = Array.isArray(values) ? values : [];
  return fromCents(list.reduce((cents, item) => cents + toCents(selector(item)), 0));
}

/** Adds dollar amounts using integer-cents arithmetic. */
export function addMoney(...values) {
  return fromCents(values.reduce((cents, value) => cents + toCents(value), 0));
}

/** a - b using integer-cents arithmetic. */
export function subtractMoney(a, b) {
  return fromCents(toCents(a) - toCents(b));
}

/** value * factor (factor is a plain number, e.g. a month count), rounded to cents. */
export function multiplyMoney(value, factor) {
  const multiplier = Number(factor);
  if (!Number.isFinite(multiplier)) return 0;
  return fromCents(Math.round(toCents(value) * multiplier));
}

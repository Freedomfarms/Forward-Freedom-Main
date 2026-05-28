function sanitizeValue(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const sanitized = value
      .map((entry) => sanitizeValue(entry))
      .filter((entry) => entry !== undefined);
    return sanitized.length ? sanitized : undefined;
  }
  if (typeof value === "object") {
    const sanitized = Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, sanitizeValue(entry)])
        .filter(([, entry]) => entry !== undefined)
    );
    return Object.keys(sanitized).length ? sanitized : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return value;
}

export function logPlaidClientEvent(event, fields = {}, level = "info") {
  const payload = sanitizeValue({
    scope: "plaid-client",
    event,
    ...fields,
  });
  const logger =
    level === "error" ? console.error : level === "warn" ? console.warn : console.info;

  logger(`[plaid-client] ${JSON.stringify(payload || { scope: "plaid-client", event })}`);
}

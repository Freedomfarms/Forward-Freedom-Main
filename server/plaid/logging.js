function sanitizeLogValue(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const sanitized = value
      .map((entry) => sanitizeLogValue(entry))
      .filter((entry) => entry !== undefined);
    return sanitized.length ? sanitized : undefined;
  }
  if (typeof value === "object") {
    const sanitized = Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, sanitizeLogValue(entry)])
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

export function getPlaidRequestId(source) {
  return (
    source?.data?.request_id ||
    source?.response?.data?.request_id ||
    source?.response?.headers?.["plaid-request-id"] ||
    source?.response?.headers?.["Plaid-Request-Id"] ||
    undefined
  );
}

export function logPlaidServerEvent(level, event, fields = {}) {
  const payload = sanitizeLogValue({
    scope: "plaid",
    event,
    ...fields,
  });
  const logger =
    level === "error" ? console.error : level === "warn" ? console.warn : console.info;

  logger(`[plaid] ${JSON.stringify(payload || { scope: "plaid", event })}`);
}

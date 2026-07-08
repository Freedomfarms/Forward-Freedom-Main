import { redactSensitive } from "../security/redaction.js";

// Drops empty/undefined entries so log lines stay compact. Runs AFTER redaction
// so that secrets and financial/PII values have already been stripped.
function compactLogValue(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const compacted = value
      .map((entry) => compactLogValue(entry))
      .filter((entry) => entry !== undefined);
    return compacted.length ? compacted : undefined;
  }
  if (typeof value === "object") {
    const compacted = Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, compactLogValue(entry)])
        .filter(([, entry]) => entry !== undefined)
    );
    return Object.keys(compacted).length ? compacted : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return value;
}

function sanitizeLogValue(value) {
  return compactLogValue(redactSensitive(value));
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

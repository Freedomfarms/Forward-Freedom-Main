// Defense-in-depth log redaction. Every server-side log payload passes through
// this module so that secrets and financial/PII values can never be written to
// stdout/stderr (and therefore to any log aggregator or error tracker), even if
// a future code path accidentally passes a raw Plaid/axios object into a logger.

const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 512;

// Object keys whose value must always be redacted, regardless of content.
const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|ciphertext|private[-_]?key|\bpin\b|ssn|social[-_]?security|account[-_]?number|routing|card[-_]?number|\bcvv\b|\biv\b|auth[-_]?tag|\bcontent\b|balance|\bamount\b|\bmerchant|\bemail\b|\bphone\b|\baddress\b)/i;

// String values that must be redacted no matter which key they appear under.
// Anchored full-value matches are handled first, then in-text scrubbing catches
// secrets embedded inside larger strings (e.g. error messages or stack traces).
const IN_TEXT_SECRET_PATTERNS = [
  [/(access|public)-(sandbox|development|production)-[A-Za-z0-9-]+/gi, REDACTED],
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]"],
];

export function isSensitiveKey(key) {
  return typeof key === "string" && SENSITIVE_KEY_PATTERN.test(key);
}

function scrubSecretsInText(value) {
  let result = value;
  for (const [pattern, replacement] of IN_TEXT_SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function truncate(value) {
  return value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : value;
}

export function redactSensitive(value, key, seen = new WeakSet()) {
  if (value == null) return value;

  if (typeof value === "string") {
    if (isSensitiveKey(key)) return REDACTED;
    return truncate(scrubSecretsInText(value));
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return isSensitiveKey(key) ? REDACTED : value;
  }

  if (isSensitiveKey(key)) {
    // A sensitive key with an object/array value: drop the whole subtree.
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry, key, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitive(entryValue, entryKey, seen),
      ])
    );
  }

  return undefined;
}

// Builds a compact, redacted, non-sensitive summary of an Error so that logging
// an internal error never serializes attached request/response payloads (axios
// errors, for example, carry access tokens and Plaid secrets on error.config).
export function summarizeError(error) {
  if (!error || typeof error !== "object") {
    return typeof error === "string" ? scrubSecretsInText(error) : error;
  }

  const summary = {
    name: typeof error.name === "string" ? error.name : undefined,
    message: typeof error.message === "string" ? error.message : undefined,
    code: error.code,
    status: error.status ?? error.statusCode ?? error.response?.status,
    stack: typeof error.stack === "string" ? error.stack : undefined,
  };

  return redactSensitive(summary);
}

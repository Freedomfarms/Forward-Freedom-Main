const URL_SECRET = /postgres(?:ql)?:\/\/[^\s'"]+/gi;
const KEY_SECRET = /\b(?:sk-[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9_+/=-]{8,}|BSA-[A-Za-z0-9_-]{8,})/g;
const EMAIL_SECRET = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LOG_TOKEN = /^[A-Za-z0-9_.:-]{1,80}$/;

function logToken(value) {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  return LOG_TOKEN.test(text) ? text : "";
}

export function redactSecrets(value) {
  return String(value ?? "")
    .replace(URL_SECRET, "postgresql://<redacted>")
    .replace(KEY_SECRET, "<redacted>")
    .replace(EMAIL_SECRET, "<redacted>");
}

// Server logs only. The chat stream keeps the generic sentence.
export function providerErrorFields(error) {
  const status = Number.isInteger(error?.status) ? error.status : "";
  return {
    operation: typeof error?.operation === "string" && error.operation ? error.operation : "turn",
    status,
    stage: logToken(error?.stage),
    submissionId: logToken(error?.submissionId),
    turnId: logToken(error?.turnId),
    sessionId: logToken(error?.sessionId),
    providerStatus: logToken(error?.providerStatus),
    message: redactSecrets(error?.message || error?.name || "Error").slice(0, 300),
  };
}

export function connectionLabel(connectionString) {
  const url = connectionUrl(connectionString);
  if (!url) return null;
  const database = decodeURIComponent(url.pathname.replace(/^\//, "").split("/")[0] || "");
  return {
    host: url.hostname || null,
    port: url.port || null,
    database: database || null,
  };
}

// Supabase puts the project ref in db.<ref>.supabase.co or in the pooler
// username role.<ref>. The role name and password are not returned.
export function projectRefFromConnection(connectionString) {
  const url = connectionUrl(connectionString);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const hostRef = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1] || "";
  const username = decodeURIComponent(url.username || "");
  const userRef = username.includes(".") ? username.split(".").slice(1).join(".") : "";
  return hostRef || userRef || null;
}

function connectionUrl(connectionString) {
  try {
    return new URL(connectionString);
  } catch {
    return null;
  }
}

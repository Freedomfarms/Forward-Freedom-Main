import { classifyChiefFailure } from "../../../src/utils/chiefErrors.js";

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

const MANAGED_OPS =
  /^(listAgents|createAgent|listEvents|sendEvents|createSession|listMemoryStores|createMemoryStore|retrieveEnvironment|createEnvironment)$/;

function logComponent(operation, category, hint) {
  const hinted = logToken(hint);
  if (hinted) return hinted;
  if (category && category !== "unknown" && category !== "turn") return logToken(category);
  if (MANAGED_OPS.test(operation)) return "managed_agent";
  return "turn";
}

function logMessage(error) {
  const raw = String(error?.message || error?.name || "Error").split("\n")[0];
  return redactSecrets(raw).slice(0, 300);
}

// Server logs only. The chat stream keeps a classified user sentence, or the
// generic sentence when the failure is not a known kind.
export function providerErrorFields(error, extras = {}) {
  const extra = extras && typeof extras === "object" ? extras : {};
  const operation =
    (typeof extra.operation === "string" && extra.operation) ||
    (typeof error?.operation === "string" && error.operation) ||
    "turn";
  const status = Number.isInteger(error?.status) ? error.status : "";
  const submissionId = logToken(extra.submissionId || error?.submissionId);
  const turnId = logToken(extra.turnId || error?.turnId);
  const sessionId = logToken(extra.sessionId || error?.sessionId);
  const classified = classifyChiefFailure({
    message: error?.message,
    status: Number.isInteger(error?.status) ? error.status : undefined,
    name: error?.name,
    code: extra.code || error?.code,
    operation,
    component: extra.component || error?.component,
    turnStatus: extra.turnStatus,
  });
  return {
    operation,
    status,
    stage: logToken(extra.stage || error?.stage),
    submissionId,
    turnId,
    sessionId,
    providerStatus: logToken(extra.providerStatus || error?.providerStatus),
    message: logMessage(error),
    component: logComponent(
      operation,
      classified.category,
      extra.component || error?.component || classified.component
    ),
    category: classified.category,
    duration: classified.duration,
    correlationId: logToken(extra.correlationId) || submissionId || turnId || sessionId,
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

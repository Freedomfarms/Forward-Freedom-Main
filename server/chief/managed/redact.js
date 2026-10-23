const URL_SECRET = /postgres(?:ql)?:\/\/[^\s'"]+/gi;
const KEY_SECRET = /\b(?:sk-ant-|whsec_)[A-Za-z0-9_+/=-]{8,}/g;

export function redactSecrets(value) {
  return String(value ?? "")
    .replace(URL_SECRET, "postgresql://<redacted>")
    .replace(KEY_SECRET, "<redacted>");
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

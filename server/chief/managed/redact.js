const URL_SECRET = /postgres(?:ql)?:\/\/[^\s'"]+/gi;
const KEY_SECRET = /\b(?:sk-ant-|whsec_)[A-Za-z0-9_+/=-]{8,}/g;

export function redactSecrets(value) {
  return String(value ?? "")
    .replace(URL_SECRET, "postgresql://<redacted>")
    .replace(KEY_SECRET, "<redacted>");
}

export function connectionLabel(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return null;
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, "").split("/")[0] || "");
  return {
    host: url.hostname || null,
    port: url.port || null,
    database: database || null,
  };
}

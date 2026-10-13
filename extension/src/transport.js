// Capture responses are status and code only.
// Response body text is never copied into the error.

const ACCEPTED = new Set(["imported", "updated", "duplicate"]);
const MAX_PAYLOAD_CHARS = 900_000;

export function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && local) return url.origin;
  if (url.protocol !== "https:") return null;
  if (url.hostname === "claude.ai" || url.hostname === "chatgpt.com") return null;
  return url.origin;
}

export function captureBody(item) {
  return {
    provider: item.provider,
    externalId: item.externalId,
    ...(item.title ? { title: item.title } : {}),
    messages: (item.messages ?? []).map((message) => ({
      role: message.role,
      text: message.text,
      ...(message.externalId ? { externalId: message.externalId } : {}),
      ...(message.sourceCreatedAt ? { sourceCreatedAt: message.sourceCreatedAt } : {}),
    })),
  };
}

export function payloadTooLarge(item) {
  try {
    return JSON.stringify(captureBody(item)).length > MAX_PAYLOAD_CHARS;
  } catch {
    return true;
  }
}

export function interpretResponse(status, body) {
  const code = typeof body?.code === "string" ? body.code : "";
  const archiveStatus = typeof body?.status === "string" ? body.status : "";
  if (status >= 200 && status < 300 && ACCEPTED.has(archiveStatus)) {
    return { ok: true, retry: false, code: archiveStatus };
  }
  if (status === 401 || code === "AUTH") return { ok: false, retry: false, code: "AUTH" };
  if (code === "PAUSED") return { ok: false, retry: false, code: "PAUSED" };
  if (status === 403 || code === "DISABLED") return { ok: false, retry: false, code: "DISABLED" };
  if (status === 409 || code === "PARTIAL") return { ok: false, retry: false, code: "PARTIAL" };
  if (status === 413 || code === "OVERSIZED") return { ok: false, retry: false, code: "OVERSIZED" };
  if (status === 400 || code === "REJECTED") return { ok: false, retry: false, code: "REJECTED" };
  if (status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599)) {
    return { ok: false, retry: true, code: "TRANSIENT" };
  }
  return { ok: false, retry: false, code: "REJECTED" };
}

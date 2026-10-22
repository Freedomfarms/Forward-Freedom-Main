import crypto from "node:crypto";

const TOLERANCE_MS = 5 * 60 * 1000;

export function verifyStandardWebhook({ rawBody, headers, secret, now = Date.now() }) {
  if (!secret) return { ok: false, status: 503, reason: "missing_secret" };
  const id = header(headers, "webhook-id");
  const timestamp = header(headers, "webhook-timestamp");
  const signature = header(headers, "webhook-signature");
  if (!id || !timestamp || !signature || !rawBody) {
    return { ok: false, status: 401, reason: "missing_fields" };
  }
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, status: 401, reason: "bad_timestamp" };
  if (Math.abs(now - seconds * 1000) > TOLERANCE_MS) {
    return { ok: false, status: 401, reason: "stale" };
  }
  const key = decodeSecret(secret);
  const expected = crypto
    .createHmac("sha256", key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");
  const match = signature.split(" ").some((part) => {
    const value = part.startsWith("v1,") ? part.slice(3) : "";
    if (!value) return false;
    const left = Buffer.from(value);
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
  return match ? { ok: true, webhookId: id } : { ok: false, status: 401, reason: "bad_signature" };
}

export function readSessionIdled(payload) {
  if (!payload || payload.type !== "session.status_idled") return null;
  const sessionId =
    payload.session_id || payload.id || payload.data?.session_id || payload.data?.id || null;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function header(headers, name) {
  if (!headers) return "";
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target)
      return Array.isArray(value) ? String(value[0] || "") : String(value || "");
  }
  return "";
}

function decodeSecret(secret) {
  const trimmed = String(secret).startsWith("whsec_")
    ? String(secret).slice("whsec_".length)
    : String(secret);
  return Buffer.from(trimmed, "base64");
}

export async function readRawBody(request) {
  if (Buffer.isBuffer(request?.body)) return request.body.toString("utf8");
  if (typeof request?.body === "string") return request.body;
  if (Buffer.isBuffer(request?.rawBody)) return request.rawBody.toString("utf8");
  if (typeof request?.rawBody === "string") return request.rawBody;
  if (request?.body == null && typeof request?.[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length) return Buffer.concat(chunks).toString("utf8");
  }
  return "";
}

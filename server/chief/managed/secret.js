import crypto from "node:crypto";

export function bearerMatches(provided, secret) {
  if (!provided || !secret) return false;
  const left = crypto.createHash("sha256").update(String(provided)).digest();
  const right = crypto.createHash("sha256").update(String(secret)).digest();
  return crypto.timingSafeEqual(left, right);
}

export function readBearer(request) {
  const headers = request?.headers || {};
  const raw = headers.authorization || headers.Authorization || "";
  const match = String(raw).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

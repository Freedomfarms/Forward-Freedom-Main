// Per-user workforce report key.
//
// The plaintext is returned once to the signed-in user and is never stored.
// The binding keeps only a SHA-256 hash. The token embeds the Freedom OS user
// id so the ingest can open that user's row-level-security context without a
// service-role lookup. The body of a report cannot choose a different user:
// changing the embedded id changes the hash, and the other user's binding
// will not match.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "ffr";
const TOKEN_MAX = 512;
const USER_ID_MAX = 128;

export function hashReportToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createReportToken(userId) {
  if (typeof userId !== "string" || userId.trim() === "" || userId.length > USER_ID_MAX) {
    throw new Error("report key requires a user");
  }
  const idPart = Buffer.from(userId, "utf8").toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  return `${PREFIX}.${idPart}.${secret}`;
}

export function parseReportToken(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || parts[2].length < 43) return null;
  const userId = Buffer.from(parts[1], "base64url").toString("utf8");
  if (!userId || userId.length > USER_ID_MAX) return null;
  if (Buffer.from(userId, "utf8").toString("base64url") !== parts[1]) return null;
  return { userId, token };
}

export function reportTokenMatches(token, storedHash) {
  if (typeof token !== "string" || typeof storedHash !== "string" || storedHash.length !== 64) {
    return false;
  }
  const digest = hashReportToken(token);
  return timingSafeEqual(Buffer.from(digest), Buffer.from(storedHash));
}

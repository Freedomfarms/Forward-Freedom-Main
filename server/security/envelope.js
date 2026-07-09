import crypto from "crypto";
import {
  getActiveKek,
  getKekByVersion,
  getLegacyDirectKey,
  isEncryptionConfigured,
} from "./keyProvider.js";

// ─────────────────────────────────────────────────────────────────────────────
// Envelope encryption for data at rest.
//
// Every value is encrypted with a fresh random Data-Encryption-Key (DEK); the
// DEK is then wrapped by a versioned Key-Encryption-Key (KEK) from keyProvider.
// The stored ciphertext records the KEK version, so KEKs can be rotated without
// re-encrypting data and without users reconnecting Plaid.
//
// Stored format (JSON string):
//   { "v":1, "kek":"<version>", "wrap":{iv,tag,ct}, "data":{iv,tag,ct} }
//
// This maps 1:1 onto a managed KMS: swap wrapDataKey/unwrapDataKey below for
// KMS Encrypt/Decrypt (the "kek" version becomes the KMS key id/alias) and the
// on-disk format is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;
const DEK_LENGTH_BYTES = 32;
const ENVELOPE_VERSION = 1;

export { isEncryptionConfigured };

function gcmEncrypt(key, plaintextBuffer) {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

function gcmDecrypt(key, segment) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(segment.iv, "base64"));
  decipher.setAuthTag(Buffer.from(segment.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(segment.ct, "base64")),
    decipher.final(),
  ]);
}

// KEK operations. Replace these two functions with KMS Encrypt/Decrypt to move
// key custody to a managed KMS without changing the stored envelope format.
function wrapDataKey(dek) {
  const { version, key } = getActiveKek();
  return { kek: version, wrap: gcmEncrypt(key, dek) };
}

function unwrapDataKey(kekVersion, wrap) {
  return gcmDecrypt(getKekByVersion(kekVersion), wrap);
}

function isLegacyDirectPayload(parsed) {
  return (
    parsed &&
    typeof parsed === "object" &&
    parsed.v == null &&
    typeof parsed.iv === "string" &&
    typeof parsed.authTag === "string" &&
    typeof parsed.content === "string"
  );
}

// Decrypts values produced by the original pre-envelope scheme (direct AES with
// a key derived from PLAID_TOKEN_ENCRYPTION_KEY). Kept only so historic records
// keep working until they are re-encrypted on their next write.
function decryptLegacyDirect(parsed) {
  const key = getLegacyDirectKey();
  if (!key) {
    throw new Error("Cannot decrypt legacy value: PLAID_TOKEN_ENCRYPTION_KEY is not configured.");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.content, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function encrypt(plaintext) {
  if (!isEncryptionConfigured()) {
    throw new Error("Encryption is not configured; refusing to store sensitive data in plaintext.");
  }
  const dek = crypto.randomBytes(DEK_LENGTH_BYTES);
  const data = gcmEncrypt(dek, Buffer.from(String(plaintext), "utf8"));
  const { kek, wrap } = wrapDataKey(dek);
  return JSON.stringify({ v: ENVELOPE_VERSION, kek, wrap, data });
}

export function decrypt(payload) {
  if (payload == null || payload === "") {
    return null;
  }
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;

  if (isLegacyDirectPayload(parsed)) {
    return decryptLegacyDirect(parsed);
  }

  const dek = unwrapDataKey(parsed.kek, parsed.wrap);
  return gcmDecrypt(dek, parsed.data).toString("utf8");
}

// Convenience helpers for the value types stored in the schema.
export function encryptNumber(value) {
  const numeric = Number(value);
  return encrypt(String(Number.isFinite(numeric) ? numeric : 0));
}

export function decryptNumber(payload) {
  const decrypted = decrypt(payload);
  return decrypted == null ? null : Number(decrypted);
}

export function encryptJson(value) {
  return encrypt(JSON.stringify(value ?? null));
}

export function decryptJson(payload) {
  const decrypted = decrypt(payload);
  return decrypted == null ? null : JSON.parse(decrypted);
}

// Re-encrypts a value under the currently active KEK. Used by the rotation /
// backfill script; a no-op-shaped helper that always returns active-KEK output.
export function reEncrypt(payload) {
  return encrypt(decrypt(payload));
}

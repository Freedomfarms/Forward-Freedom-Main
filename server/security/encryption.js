import crypto from "crypto";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH_BYTES = 12;

function getEncryptionKeyBuffer() {
  const secret = process.env.PLAID_TOKEN_ENCRYPTION_KEY || "";
  if (!secret.trim()) return null;
  return crypto.createHash("sha256").update(secret).digest();
}

export function isSensitiveEncryptionConfigured() {
  return Boolean(getEncryptionKeyBuffer());
}

export function encryptSensitiveValue(value) {
  const key = getEncryptionKeyBuffer();
  if (!key) {
    throw new Error("PLAID_TOKEN_ENCRYPTION_KEY is required for secure Plaid token storage.");
  }

  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    content: encrypted.toString("base64"),
  });
}

export function decryptSensitiveValue(payload) {
  const key = getEncryptionKeyBuffer();
  if (!key) {
    throw new Error("PLAID_TOKEN_ENCRYPTION_KEY is required for secure Plaid token storage.");
  }

  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM,
    key,
    Buffer.from(parsed.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(parsed.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.content, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

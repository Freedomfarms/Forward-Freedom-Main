import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Key provider — the single boundary between the application and the key
// material used for envelope encryption.
//
// Today this is a *portable* provider: Key-Encryption-Keys (KEKs) are supplied
// through environment variables. It is deliberately shaped like a KMS so it can
// be swapped for AWS KMS / GCP KMS / Vault later WITHOUT changing the stored
// ciphertext format or forcing users to reconnect Plaid:
//
//   • Each stored envelope records the KEK *version* that wrapped its data key.
//     Old envelopes keep decrypting with their original KEK, so rotating the
//     active KEK never invalidates existing data (no re-link required).
//   • To migrate to a managed KMS, replace `wrapDataKey` / `unwrapDataKey` in
//     envelope.js with KMS Encrypt/Decrypt calls keyed by these versions. The
//     rest of the system is unaffected.
//
// Configuration (portable mode):
//   FFF_ENCRYPTION_KEYS            "1:<base64-32-bytes>,2:<base64-32-bytes>"
//   FFF_ENCRYPTION_ACTIVE_VERSION  "2"
//
// Backwards compatibility:
//   If FFF_ENCRYPTION_KEYS is not set but PLAID_TOKEN_ENCRYPTION_KEY is, a KEK
//   (version "pk1") is derived from it so existing deployments keep working with
//   no new configuration. Access tokens encrypted with the *legacy* direct
//   scheme are still decryptable via getLegacyDirectKey().
// ─────────────────────────────────────────────────────────────────────────────

const KEY_LENGTH_BYTES = 32;
const MIN_SECRET_LENGTH = 32;
const LEGACY_KEK_VERSION = "pk1";

let cache = null;

function deriveKeyFromSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest();
}

function parseKeyList(raw) {
  const keys = new Map();
  for (const entry of String(raw).split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error('FFF_ENCRYPTION_KEYS entries must be formatted as "version:base64key".');
    }
    const version = trimmed.slice(0, separatorIndex).trim();
    const material = trimmed.slice(separatorIndex + 1).trim();
    const keyBuffer = Buffer.from(material, "base64");
    if (keyBuffer.length !== KEY_LENGTH_BYTES) {
      throw new Error(
        `FFF_ENCRYPTION_KEYS version "${version}" must decode to exactly ${KEY_LENGTH_BYTES} bytes.`
      );
    }
    keys.set(version, keyBuffer);
  }
  return keys;
}

function buildKeyring() {
  const keys = new Map();
  let activeVersion = null;

  const configuredKeys = (process.env.FFF_ENCRYPTION_KEYS || "").trim();
  if (configuredKeys) {
    for (const [version, key] of parseKeyList(configuredKeys)) {
      keys.set(version, key);
    }
    const requestedActive = (process.env.FFF_ENCRYPTION_ACTIVE_VERSION || "").trim();
    if (requestedActive) {
      if (!keys.has(requestedActive)) {
        throw new Error(
          `FFF_ENCRYPTION_ACTIVE_VERSION "${requestedActive}" is not present in FFF_ENCRYPTION_KEYS.`
        );
      }
      activeVersion = requestedActive;
    } else {
      // Default to the highest version so adding a new key rotates automatically.
      activeVersion = [...keys.keys()].sort().at(-1) || null;
    }
  }

  // Backwards-compatible KEK derived from the original single secret.
  const legacySecret = (process.env.PLAID_TOKEN_ENCRYPTION_KEY || "").trim();
  const legacyValid = legacySecret.length >= MIN_SECRET_LENGTH;
  if (legacyValid && !keys.has(LEGACY_KEK_VERSION)) {
    keys.set(LEGACY_KEK_VERSION, deriveKeyFromSecret(legacySecret));
  }
  if (!activeVersion && legacyValid) {
    activeVersion = LEGACY_KEK_VERSION;
  }

  return {
    keys,
    activeVersion,
    legacyDirectKey: legacyValid ? deriveKeyFromSecret(legacySecret) : null,
  };
}

function getKeyring() {
  if (!cache) {
    cache = buildKeyring();
  }
  return cache;
}

// Test/rotation helper: forces the keyring to be rebuilt from the current env.
export function resetKeyProviderCache() {
  cache = null;
}

export function isEncryptionConfigured() {
  return getKeyring().activeVersion != null;
}

export function getActiveKek() {
  const { keys, activeVersion } = getKeyring();
  if (!activeVersion) {
    throw new Error(
      "No encryption key is configured. Set FFF_ENCRYPTION_KEYS (+ FFF_ENCRYPTION_ACTIVE_VERSION) or PLAID_TOKEN_ENCRYPTION_KEY."
    );
  }
  return { version: activeVersion, key: keys.get(activeVersion) };
}

export function getKekByVersion(version) {
  const key = getKeyring().keys.get(version);
  if (!key) {
    throw new Error(`No encryption key is available for KEK version "${version}".`);
  }
  return key;
}

export function listKekVersions() {
  return [...getKeyring().keys.keys()];
}

// Key used by the pre-envelope ("legacy") direct AES-256-GCM scheme so historic
// Plaid access tokens keep decrypting until they are re-wrapped on next write.
export function getLegacyDirectKey() {
  return getKeyring().legacyDirectKey;
}

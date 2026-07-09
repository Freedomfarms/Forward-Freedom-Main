import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import {
  decrypt,
  decryptJson,
  decryptNumber,
  encrypt,
  encryptJson,
  encryptNumber,
  isEncryptionConfigured,
  reEncrypt,
} from "../server/security/envelope.js";
import { resetKeyProviderCache } from "../server/security/keyProvider.js";

function base64Key() {
  return crypto.randomBytes(32).toString("base64");
}

function configureKeys(keysCsv, activeVersion, legacySecret) {
  if (keysCsv == null) delete process.env.FFF_ENCRYPTION_KEYS;
  else process.env.FFF_ENCRYPTION_KEYS = keysCsv;
  if (activeVersion == null) delete process.env.FFF_ENCRYPTION_ACTIVE_VERSION;
  else process.env.FFF_ENCRYPTION_ACTIVE_VERSION = activeVersion;
  if (legacySecret == null) delete process.env.PLAID_TOKEN_ENCRYPTION_KEY;
  else process.env.PLAID_TOKEN_ENCRYPTION_KEY = legacySecret;
  resetKeyProviderCache();
}

test("round-trips strings, numbers and JSON under envelope encryption", () => {
  configureKeys(`1:${base64Key()}`, "1");
  assert.equal(isEncryptionConfigured(), true);

  const ciphertext = encrypt("access-production-secret-token");
  assert.notEqual(ciphertext, "access-production-secret-token");
  assert.equal(ciphertext.includes("access-production"), false);
  assert.equal(decrypt(ciphertext), "access-production-secret-token");

  assert.equal(decryptNumber(encryptNumber(-1234.56)), -1234.56);
  assert.deepEqual(decryptJson(encryptJson({ interestRate: "5.5", monthlyPayment: "247.13" })), {
    interestRate: "5.5",
    monthlyPayment: "247.13",
  });
});

test("stored envelope records the active KEK version and no plaintext", () => {
  configureKeys(`7:${base64Key()}`, "7");
  const envelope = JSON.parse(encrypt("12345.67"));
  assert.equal(envelope.v, 1);
  assert.equal(envelope.kek, "7");
  assert.ok(envelope.wrap?.ct && envelope.data?.ct);
});

test("KEK rotation keeps old ciphertext decryptable without re-linking", () => {
  const keyA = base64Key();
  const keyB = base64Key();

  // Encrypt while version 1 is active.
  configureKeys(`1:${keyA}`, "1");
  const oldCiphertext = encrypt("stored-under-v1");
  assert.equal(JSON.parse(oldCiphertext).kek, "1");

  // Rotate: version 2 becomes active but version 1 is still available.
  configureKeys(`1:${keyA},2:${keyB}`, "2");
  const newCiphertext = encrypt("stored-under-v2");
  assert.equal(JSON.parse(newCiphertext).kek, "2");

  // Old data still decrypts with its recorded KEK version.
  assert.equal(decrypt(oldCiphertext), "stored-under-v1");
  assert.equal(decrypt(newCiphertext), "stored-under-v2");

  // Re-encryption migrates the old record to the active KEK.
  const migrated = reEncrypt(oldCiphertext);
  assert.equal(JSON.parse(migrated).kek, "2");
  assert.equal(decrypt(migrated), "stored-under-v1");
});

test("legacy pre-envelope access tokens still decrypt", () => {
  const legacySecret = "a".repeat(40);
  configureKeys(null, null, legacySecret);

  // Reproduce the original direct AES-256-GCM scheme.
  const key = crypto.createHash("sha256").update(legacySecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const content = Buffer.concat([
    cipher.update("access-production-legacy-token", "utf8"),
    cipher.final(),
  ]);
  const legacyPayload = JSON.stringify({
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    content: content.toString("base64"),
  });

  assert.equal(decrypt(legacyPayload), "access-production-legacy-token");

  // And new writes use envelope format while the legacy secret is present.
  const migrated = reEncrypt(legacyPayload);
  assert.equal(JSON.parse(migrated).v, 1);
  assert.equal(decrypt(migrated), "access-production-legacy-token");
});

test("encryption reports unconfigured and refuses to encrypt without a key", () => {
  configureKeys(null, null, null);
  assert.equal(isEncryptionConfigured(), false);
  assert.throws(() => encrypt("secret"), /Encryption is not configured/);
});

test("decrypt returns null for empty input", () => {
  configureKeys(`1:${base64Key()}`, "1");
  assert.equal(decrypt(null), null);
  assert.equal(decrypt(""), null);
});

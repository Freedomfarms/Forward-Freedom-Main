// Backwards-compatible facade over the envelope-encryption layer.
//
// Existing callers (Plaid handlers) import encryptSensitiveValue /
// decryptSensitiveValue / isSensitiveEncryptionConfigured. These now delegate to
// the versioned envelope implementation, so:
//   • new writes use envelope encryption with a rotatable KEK version, and
//   • old values (legacy direct-AES access tokens) still decrypt and are
//     transparently re-wrapped the next time they are written.
import { decrypt, encrypt, isEncryptionConfigured } from "./envelope.js";

export function isSensitiveEncryptionConfigured() {
  return isEncryptionConfigured();
}

export function encryptSensitiveValue(value) {
  return encrypt(value);
}

export function decryptSensitiveValue(payload) {
  return decrypt(payload);
}

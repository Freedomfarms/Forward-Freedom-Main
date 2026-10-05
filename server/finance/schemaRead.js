// Retry a user-scoped read when ciphertext columns are not on the database yet.
// The first attempt uses the current select. P2022 starts a new user-context
// transaction and retries with the legacy select. The failed statement aborts
// the first transaction, so the retry cannot reuse it.

import { isMissingEncryptionColumnError } from "../db/schemaCapabilities.js";

export function classifyFinanceReadError(error) {
  if (isSchemaMismatch(error)) return "schema";
  const message = String(error?.message || "");
  if (/decrypt|encryption key|kek version|cannot decrypt|no encryption key/i.test(message)) {
    return "decrypt";
  }
  return "query";
}

export function isSchemaMismatch(error) {
  if (isMissingEncryptionColumnError(error)) return true;
  const code = String(error?.code || error?.cause?.code || "");
  const message = String(error?.message || "");
  return (
    code === "P2022" ||
    code === "42703" ||
    (/ciphertext/i.test(message) && /does not exist|unknown column|column .* not found/i.test(message))
  );
}

export async function queryWithSchemaFallback(userId, withUser, run) {
  try {
    return await withUser(userId, (tx) => run(tx, true));
  } catch (error) {
    if (!isSchemaMismatch(error)) throw error;
    return await withUser(userId, (tx) => run(tx, false));
  }
}

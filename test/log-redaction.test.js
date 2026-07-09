import test from "node:test";
import assert from "node:assert/strict";

import { redactSensitive, summarizeError } from "../server/security/redaction.js";
import { logPlaidServerEvent } from "../server/plaid/logging.js";

test("redacts Plaid access tokens by key and by value pattern", () => {
  const result = redactSensitive({
    accessToken: "access-production-11111111-2222-3333-4444-555555555555",
    accessTokenCiphertext: '{"iv":"abc","authTag":"def","content":"ghi"}',
    note: "linked with access-sandbox-aaaa-bbbb-cccc token",
  });

  assert.equal(result.accessToken, "[REDACTED]");
  assert.equal(result.accessTokenCiphertext, "[REDACTED]");
  assert.equal(result.note.includes("access-sandbox"), false);
  assert.equal(result.note.includes("[REDACTED]"), true);
});

test("redacts financial and PII values while keeping diagnostic identifiers", () => {
  const result = redactSensitive({
    itemId: "item-123",
    institutionId: "ins_1",
    requestId: "req-9",
    code: "PRODUCT_NOT_READY",
    balance: 12345.67,
    amount: -42.5,
    merchant: "Corner Grocery",
    email: "user@example.com",
    accountIds: ["acc-1", "acc-2"],
  });

  assert.equal(result.itemId, "item-123");
  assert.equal(result.institutionId, "ins_1");
  assert.equal(result.requestId, "req-9");
  assert.equal(result.code, "PRODUCT_NOT_READY");
  assert.deepEqual(result.accountIds, ["acc-1", "acc-2"]);
  assert.equal(result.balance, "[REDACTED]");
  assert.equal(result.amount, "[REDACTED]");
  assert.equal(result.merchant, "[REDACTED]");
  assert.equal(result.email, "[REDACTED]");
});

test("redacts bearer tokens and JWTs embedded in strings", () => {
  const result = redactSensitive({
    authorization: "Bearer eyJhbGciOiJI.payloadpart.signaturepart",
    freeText: "header was Bearer eyJabc.def.ghi and should be scrubbed",
  });

  assert.equal(result.authorization, "[REDACTED]");
  assert.equal(result.freeText.includes("eyJabc.def.ghi"), false);
});

test("summarizeError never serializes attached axios request/response payloads", () => {
  // Mimic an axios error thrown by the Plaid SDK, which carries the outbound
  // request config (Plaid secret + access token) and response data.
  const axiosError = Object.assign(new Error("Request failed with status code 400"), {
    code: "ERR_BAD_REQUEST",
    config: {
      headers: {
        "PLAID-SECRET": "super-secret-value",
        "PLAID-CLIENT-ID": "client-id",
      },
      data: JSON.stringify({ access_token: "access-production-leak-me" }),
    },
    response: {
      status: 400,
      data: { accounts: [{ balance: 9999, account_number: "1234567890" }] },
    },
  });

  const summary = summarizeError(axiosError);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.name, "Error");
  assert.equal(summary.status, 400);
  assert.equal(serialized.includes("super-secret-value"), false);
  assert.equal(serialized.includes("access-production-leak-me"), false);
  assert.equal(serialized.includes("1234567890"), false);
  assert.equal(serialized.includes("9999"), false);
});

test("logPlaidServerEvent output contains no secret material", () => {
  const original = console.info;
  const lines = [];
  console.info = (line) => lines.push(line);
  try {
    logPlaidServerEvent("info", "public_token_exchanged", {
      itemId: "item-123",
      accessToken: "access-production-do-not-log",
      publicToken: "public-production-do-not-log",
    });
  } finally {
    console.info = original;
  }

  const output = lines.join("\n");
  assert.equal(output.includes("item-123"), true);
  assert.equal(output.includes("do-not-log"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import {
  readRawRequestBody,
  verifyPlaidWebhookRequest,
} from "../server/plaid/webhookVerification.js";

function makeUnparsedStream(text) {
  // Mimics a request whose body has not been parsed yet (e.g. Vercel with
  // bodyParser disabled): an async-iterable stream with body === null.
  return {
    body: null,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, "utf8");
    },
  };
}

test("readRawRequestBody returns the exact bytes from a Buffer body (express.raw)", async () => {
  const raw =
    '{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","item_id":"item-123"}';
  const request = { body: Buffer.from(raw, "utf8") };
  assert.equal(await readRawRequestBody(request), raw);
});

test("readRawRequestBody returns a string body unchanged", async () => {
  const raw = '{"webhook_type":"ITEM"}';
  assert.equal(await readRawRequestBody({ body: raw }), raw);
});

test("readRawRequestBody reads request.rawBody when a runtime stashes it there", async () => {
  const raw = '{"webhook_type":"ITEM"}';
  assert.equal(await readRawRequestBody({ rawBody: Buffer.from(raw, "utf8") }), raw);
});

test("readRawRequestBody reads the raw stream when the body is unparsed", async () => {
  const raw = '{"webhook_type":"ITEM","webhook_code":"ERROR"}';
  assert.equal(await readRawRequestBody(makeUnparsedStream(raw)), raw);
});

test("readRawRequestBody fails closed for an already-parsed object body (C-1)", async () => {
  // A parsed object can no longer be reconstructed to the byte-identical payload
  // Plaid signed. The previous JSON.stringify fallback silently broke every
  // webhook signature check; we now return "" so verification fails closed.
  const request = {
    body: { webhook_type: "TRANSACTIONS", item_id: "item-123" },
  };
  assert.equal(await readRawRequestBody(request), "");
});

test("re-serializing a parsed body changes the SHA-256 hash (root cause of C-1)", () => {
  // Plaid computes request_body_sha256 over the exact bytes it transmitted.
  // Any re-serialization (here: a payload with insignificant whitespace) yields
  // different bytes and therefore a different hash, so the HMAC never matches.
  const rawFromPlaid = '{"webhook_type": "TRANSACTIONS", "item_id": "item-123"}';
  const reserialized = JSON.stringify(JSON.parse(rawFromPlaid));

  assert.notEqual(rawFromPlaid, reserialized);

  const rawHash = crypto.createHash("sha256").update(rawFromPlaid).digest("hex");
  const reserializedHash = crypto.createHash("sha256").update(reserialized).digest("hex");
  assert.notEqual(rawHash, reserializedHash);
});

test("verifyPlaidWebhookRequest fails closed without a verification header", async () => {
  const verified = await verifyPlaidWebhookRequest({ headers: {} }, '{"webhook_type":"ITEM"}');
  assert.equal(verified, false);
});

test("verifyPlaidWebhookRequest fails closed without a raw body", async () => {
  const verified = await verifyPlaidWebhookRequest(
    { headers: { "plaid-verification": "signed.jwt.value" } },
    ""
  );
  assert.equal(verified, false);
});

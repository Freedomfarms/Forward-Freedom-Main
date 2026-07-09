import crypto from "crypto";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { getPlaidClient, isPlaidConfigured } from "../plaidClient.js";

const keyCache = new Map();

function readVerificationHeader(request) {
  const headers = request?.headers || {};
  return (
    headers["plaid-verification"] ||
    headers["Plaid-Verification"] ||
    headers["PLAID-VERIFICATION"] ||
    null
  );
}

async function getVerificationKey(keyId) {
  if (keyCache.has(keyId)) {
    return keyCache.get(keyId);
  }

  const plaidClient = getPlaidClient();
  const response = await plaidClient.webhookVerificationKeyGet({ key_id: keyId });
  const key = response.data.key;
  keyCache.set(keyId, key);
  return key;
}

export async function verifyPlaidWebhookRequest(request, rawBody) {
  const signedJwt = readVerificationHeader(request);
  if (!signedJwt || !rawBody) {
    return false;
  }

  if (!isPlaidConfigured()) {
    return false;
  }

  try {
    const header = decodeProtectedHeader(signedJwt);
    const keyId = header.kid;
    if (!keyId || header.alg !== "ES256") {
      return false;
    }

    const jwk = await getVerificationKey(keyId);
    const keyLike = await importJWK(jwk, "ES256");
    const { payload } = await jwtVerify(signedJwt, keyLike, {
      maxTokenAge: "5 min",
    });

    const expectedHash = payload?.request_body_sha256;
    if (typeof expectedHash !== "string") {
      return false;
    }

    const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
    if (bodyHash.length !== expectedHash.length) {
      return false;
    }

    return crypto.timingSafeEqual(Buffer.from(bodyHash), Buffer.from(expectedHash));
  } catch {
    return false;
  }
}

export async function readRawRequestBody(request) {
  // Plaid signs the exact bytes it transmitted, so we must return those bytes
  // verbatim. We deliberately do NOT fall back to JSON.stringify(request.body):
  // once a body parser has turned the payload into a plain object the original
  // byte order/whitespace is lost, and a re-serialized body will never match
  // the signed request_body_sha256 (bug C-1). In that case we return an empty
  // string so verification fails closed rather than silently accepting an
  // unverifiable webhook.
  if (Buffer.isBuffer(request.body)) {
    return request.body.toString("utf8");
  }

  if (typeof request.body === "string") {
    return request.body;
  }

  // Some runtimes stash the untouched payload on request.rawBody.
  if (Buffer.isBuffer(request.rawBody)) {
    return request.rawBody.toString("utf8");
  }

  if (typeof request.rawBody === "string") {
    return request.rawBody;
  }

  // Body has not been parsed yet (e.g. Vercel with bodyParser disabled): read
  // the raw stream directly.
  if (request.body == null && typeof request[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    if (chunks.length) {
      return Buffer.concat(chunks).toString("utf8");
    }
  }

  return "";
}

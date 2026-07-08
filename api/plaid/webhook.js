import { handlePlaidWebhook } from "../../server/plaid/webhookHandler.js";
import { applySecurityHeaders, assertMethod } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, plaidWebhookRateLimit } from "../../server/http/rateLimit.js";

// Disable the platform body parser so the handler can read the exact bytes
// Plaid signed. Without this, the parsed-object body cannot be re-serialized to
// the byte-identical payload required for SHA-256 signature verification.
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!assertMethod(request, response, "POST")) return;
  if (!(await enforceRateLimit(request, response, plaidWebhookRateLimit))) return;
  return handlePlaidWebhook(request, response);
}

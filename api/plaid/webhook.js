import { handlePlaidWebhook } from "../../server/plaid/webhookHandler.js";
import { applySecurityHeaders, assertMethod } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, plaidWebhookRateLimit } from "../../server/http/rateLimit.js";

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!assertMethod(request, response, "POST")) return;
  if (!(await enforceRateLimit(request, response, plaidWebhookRateLimit))) return;
  return handlePlaidWebhook(request, response);
}

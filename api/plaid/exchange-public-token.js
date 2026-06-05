import { handleExchangePlaidPublicToken } from "../../server/plaid/handlers.js";
import { enforceRateLimit, plaidExchangeRateLimit } from "../../server/http/rateLimit.js";
import { applySecurityHeaders, assertMethod } from "../../server/http/responseHelpers.js";

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!assertMethod(request, response, "POST")) return;
  if (!(await enforceRateLimit(request, response, plaidExchangeRateLimit))) return;
  return handleExchangePlaidPublicToken(request, response);
}

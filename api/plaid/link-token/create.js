import { handleCreatePlaidLinkToken } from "../../../server/plaid/handlers.js";
import { enforceRateLimit, plaidLinkRateLimit } from "../../../server/http/rateLimit.js";
import { applySecurityHeaders, assertMethod } from "../../../server/http/responseHelpers.js";

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!assertMethod(request, response, "POST")) return;
  if (!(await enforceRateLimit(request, response, plaidLinkRateLimit))) return;
  return handleCreatePlaidLinkToken(request, response);
}

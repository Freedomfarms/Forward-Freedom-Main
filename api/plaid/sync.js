import { handleSyncPlaidWorkspace } from "../../server/plaid/handlers.js";
import { enforceRateLimit, plaidSyncRateLimit } from "../../server/http/rateLimit.js";
import { applySecurityHeaders, assertMethod } from "../../server/http/responseHelpers.js";

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!assertMethod(request, response, "GET")) return;
  if (!(await enforceRateLimit(request, response, plaidSyncRateLimit))) return;
  return handleSyncPlaidWorkspace(request, response);
}

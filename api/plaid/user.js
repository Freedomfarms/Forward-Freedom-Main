import { handleDeletePlaidWorkspace } from "../../server/plaid/handlers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { applySecurityHeaders, assertMethod } from "../../server/http/responseHelpers.js";

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!assertMethod(request, response, "DELETE")) return;
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  return handleDeletePlaidWorkspace(request, response);
}

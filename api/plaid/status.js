import { handlePlaidStatus } from "../../server/plaid/handlers.js";
import { applySecurityHeaders, assertMethod } from "../../server/http/responseHelpers.js";

export default function handler(request, response) {
  applySecurityHeaders(response);
  if (!assertMethod(request, response, "GET")) return;
  return handlePlaidStatus(request, response);
}

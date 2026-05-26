import { handleExchangePlaidPublicToken } from "../../server/plaid/handlers.js";
import { applySecurityHeaders, assertMethod } from "../../server/http/responseHelpers.js";

export default function handler(request, response) {
  applySecurityHeaders(response);
  if (!assertMethod(request, response, "POST")) return;
  return handleExchangePlaidPublicToken(request, response);
}

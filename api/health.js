import { applySecurityHeaders } from "../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../server/http/rateLimit.js";

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  response.status(200).json({ status: "ok" });
}

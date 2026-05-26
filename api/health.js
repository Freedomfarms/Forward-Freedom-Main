import { applySecurityHeaders } from "../server/http/responseHelpers.js";

export default function handler(_request, response) {
  applySecurityHeaders(response);
  response.status(200).json({ status: "ok" });
}

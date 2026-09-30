// GET /api/chief/models — models the deployment can actually call.
//
// A provider is listed only after it has been instantiated, which requires
// both enablement and a credential. The response has ids and labels. It does
// not include secrets, env var names, or skipped providers.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { projectConfiguredModels } from "../../server/chief/models/catalog.js";
import { createModelEngine } from "../../server/chief/models/engine.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

export async function handleChiefModels(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  if (request.method !== "GET") {
    response.status(405).json({ error: "GET required" });
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  try {
    await authenticate(request);
  } catch (error) {
    response.status(error.status || 401).json({ error: error.message || "Unauthorized" });
    return;
  }

  const engine = deps.engine ?? createModelEngine();
  const available = new Set(engine.availableModelKeys());
  const defaultModel =
    typeof engine.config?.defaultModel === "string" && available.has(engine.config.defaultModel)
      ? engine.config.defaultModel
      : null;
  response.status(200).json({
    models: projectConfiguredModels(engine.listModels()),
    defaultModel,
  });
}

export default function handler(request, response) {
  return handleChiefModels(request, response);
}

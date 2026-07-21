import { authenticateRequest } from "../../../../server/auth/verifyAuth.js";
import { withUserContext } from "../../../../server/db/prisma.js";
import {
  agentLlmRateLimit,
  enforceRateLimit,
  generalApiRateLimit,
} from "../../../../server/http/rateLimit.js";
import { applySecurityHeaders } from "../../../../server/http/responseHelpers.js";
import {
  ensureCeoAgentConfig,
  respondAgentApiError,
} from "../../../../server/agents/apiHelpers.js";
import {
  generateNarrativeProfile,
  readNarrativeProfile,
} from "../../../../server/agents/narrativeProfile.js";

// GET  /api/agents/ceo/profile/narrative — cached long-form profile (or null)
// POST /api/agents/ceo/profile/narrative — generate / refresh and persist

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!["GET", "POST"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }

  const mayGenerate = request.method === "POST";
  const limiter = mayGenerate ? agentLlmRateLimit : generalApiRateLimit;
  if (!(await enforceRateLimit(request, response, limiter))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    await withUserContext(decodedToken.uid, (tx) => ensureCeoAgentConfig(tx, decodedToken.uid));

    if (request.method === "GET") {
      const narrative = await readNarrativeProfile(decodedToken.uid);
      return response.status(200).json({
        narrativeProfile: {
          profile: narrative.profile,
          generatedAt: narrative.generatedAt,
          insufficient: narrative.insufficient,
        },
      });
    }

    const result = await generateNarrativeProfile(decodedToken.uid);
    return response.status(200).json({
      narrativeProfile: {
        profile: result.profile,
        generatedAt: result.generatedAt,
        insufficient: result.insufficient,
      },
      refreshed: true,
    });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/ceo/profile/narrative",
      error,
      "Unable to load or generate your profile."
    );
  }
}

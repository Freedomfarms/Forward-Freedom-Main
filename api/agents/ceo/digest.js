import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { withUserContext } from "../../../server/db/prisma.js";
import { decrypt } from "../../../server/security/envelope.js";
import {
  agentLlmRateLimit,
  enforceRateLimit,
  generalApiRateLimit,
} from "../../../server/http/rateLimit.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import {
  ensureCeoAgentConfig,
  respondAgentApiError,
} from "../../../server/agents/apiHelpers.js";
import { generateDigest } from "../../../server/agents/digest.js";

const DIGEST_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

function wantsRefresh(request) {
  const refresh = request.query?.refresh;
  return refresh === "true" || refresh === "1" || refresh === true;
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!["GET", "POST"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }

  // Requests that can trigger an LLM call (forced regeneration) get the
  // stricter budget; plain cached reads stay on the general limiter.
  const mayGenerate = request.method === "POST" || wantsRefresh(request);
  const limiter = mayGenerate ? agentLlmRateLimit : generalApiRateLimit;
  if (!(await enforceRateLimit(request, response, limiter))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const ceoConfig = await withUserContext(decodedToken.uid, (tx) =>
      ensureCeoAgentConfig(tx, decodedToken.uid)
    );

    const lastDigestAt = ceoConfig.lastDigestAt ? new Date(ceoConfig.lastDigestAt) : null;
    const stale = !lastDigestAt || Date.now() - lastDigestAt.getTime() > DIGEST_STALE_AFTER_MS;

    if (request.method === "GET" && !wantsRefresh(request) && !stale && ceoConfig.lastDigestCiphertext) {
      return response.status(200).json({
        digest: decrypt(ceoConfig.lastDigestCiphertext),
        generatedAt: lastDigestAt,
        refreshed: false,
      });
    }

    const { digest, generatedAt } = await generateDigest(decodedToken.uid);
    return response.status(200).json({ digest, generatedAt, refreshed: true });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/ceo/digest",
      error,
      "Unable to load or generate the CEO digest."
    );
  }
}

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { withUserContext } from "../../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { readJsonBody } from "../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { AgentError } from "../../server/agents/errors.js";
import {
  CEO_PERSONALITY_PRESETS,
  ensureCeoAgentConfig,
  isValidAvatarKey,
  isValidPersonalityPreset,
  respondAgentApiError,
  serializeCeoAgentConfig,
} from "../../server/agents/apiHelpers.js";

const NAME_MAX_LENGTH = 80;

// Builds the update payload for PUT. Only name / personalityPreset /
// avatarKey are updatable — personality stays preset-only (safety contract:
// no free-text personality overrides), and profile/digest fields are owned by
// their dedicated endpoints.
function readCeoUpdate(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AgentError("A JSON object body is required.", "INVALID_AGENT_PAYLOAD", 400);
  }
  const data = {};
  if ("name" in payload) {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name || name.length > NAME_MAX_LENGTH) {
      throw new AgentError(
        `name must be a non-empty string of at most ${NAME_MAX_LENGTH} characters.`,
        "INVALID_AGENT_PAYLOAD",
        400
      );
    }
    data.name = name;
  }
  if ("personalityPreset" in payload) {
    if (!isValidPersonalityPreset(payload.personalityPreset)) {
      throw new AgentError(
        `personalityPreset must be one of: ${CEO_PERSONALITY_PRESETS.join(", ")}.`,
        "INVALID_AGENT_PAYLOAD",
        400
      );
    }
    data.personalityPreset = payload.personalityPreset;
  }
  if ("avatarKey" in payload) {
    if (payload.avatarKey !== null && !isValidAvatarKey(payload.avatarKey)) {
      throw new AgentError(
        "avatarKey must be a preset avatar key (short slug) or null.",
        "INVALID_AGENT_PAYLOAD",
        400
      );
    }
    data.avatarKey = payload.avatarKey;
  }
  if (!Object.keys(data).length) {
    throw new AgentError("No updatable fields were provided.", "INVALID_AGENT_PAYLOAD", 400);
  }
  return data;
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!["GET", "PUT"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);

    if (request.method === "GET") {
      const ceoConfig = await withUserContext(decodedToken.uid, (tx) =>
        ensureCeoAgentConfig(tx, decodedToken.uid)
      );
      return response.status(200).json({ ceoAgent: serializeCeoAgentConfig(ceoConfig) });
    }

    const data = readCeoUpdate(await readJsonBody(request));
    const updated = await withUserContext(decodedToken.uid, async (tx) => {
      const ceoConfig = await ensureCeoAgentConfig(tx, decodedToken.uid);
      return tx.ceoAgentConfig.update({ where: { id: ceoConfig.id }, data });
    });
    return response.status(200).json({ ceoAgent: serializeCeoAgentConfig(updated) });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/ceo",
      error,
      "Unable to load or update the CEO Agent configuration."
    );
  }
}

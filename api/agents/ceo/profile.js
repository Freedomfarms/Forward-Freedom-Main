import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { withUserContext } from "../../../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../../server/http/rateLimit.js";
import { readJsonBody } from "../../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { AgentError } from "../../../server/agents/errors.js";
import {
  ensureCeoAgentConfig,
  respondAgentApiError,
} from "../../../server/agents/apiHelpers.js";
import {
  applyOps,
  getProfile,
  PROFILE_CATEGORIES,
  saveProfile,
} from "../../../server/agents/profile.js";

const MAX_OPS_PER_REQUEST = 50;
const ENTRY_TEXT_MAX_LENGTH = 500;

// Translates the API's user-edit ops ({ action: "update"|"delete", category,
// id, text? }) into profile.js applyOps ops. Updates carry source
// "user_edit" (set by applyOps via the source option); deletes tombstone the
// id so automatic extraction can never re-add what the user removed.
function readProfileOps(payload) {
  const ops = payload?.ops;
  if (!Array.isArray(ops) || !ops.length) {
    throw new AgentError("Body must contain a non-empty ops array.", "INVALID_AGENT_PAYLOAD", 400);
  }
  if (ops.length > MAX_OPS_PER_REQUEST) {
    throw new AgentError(
      `At most ${MAX_OPS_PER_REQUEST} ops are allowed per request.`,
      "INVALID_AGENT_PAYLOAD",
      400
    );
  }
  return ops.map((op, index) => {
    const label = `ops[${index}]`;
    if (!op || typeof op !== "object") {
      throw new AgentError(`${label} must be an object.`, "INVALID_AGENT_PAYLOAD", 400);
    }
    const id = typeof op.id === "string" ? op.id.trim() : "";
    if (!id) {
      throw new AgentError(`${label}.id is required.`, "INVALID_AGENT_PAYLOAD", 400);
    }
    if (op.category != null && !PROFILE_CATEGORIES.includes(op.category)) {
      throw new AgentError(
        `${label}.category must be one of: ${PROFILE_CATEGORIES.join(", ")}.`,
        "INVALID_AGENT_PAYLOAD",
        400
      );
    }
    if (op.action === "delete") {
      return { op: "remove", id };
    }
    if (op.action === "update") {
      const text = typeof op.text === "string" ? op.text.trim() : "";
      if (!text || text.length > ENTRY_TEXT_MAX_LENGTH) {
        throw new AgentError(
          `${label}.text must be a non-empty string of at most ${ENTRY_TEXT_MAX_LENGTH} characters.`,
          "INVALID_AGENT_PAYLOAD",
          400
        );
      }
      return { op: "update", id, text };
    }
    throw new AgentError(
      `${label}.action must be "update" or "delete".`,
      "INVALID_AGENT_PAYLOAD",
      400
    );
  });
}

function buildProfileResponse(profile, ceoConfig) {
  // Entries already carry provenance ({ source, addedAt, updatedAt });
  // tombstones are returned as metadata (count only — the ids are internal).
  return {
    profile: {
      categories: profile.categories,
      tombstones: { count: profile.tombstones.length },
      updatedAt: ceoConfig?.profileUpdatedAt ?? null,
    },
  };
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!["GET", "PATCH"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);

    // Ensure the CEO config exists first: the profile lives on it, and
    // saveProfile is a no-op without one.
    const ceoConfig = await withUserContext(decodedToken.uid, (tx) =>
      ensureCeoAgentConfig(tx, decodedToken.uid)
    );

    if (request.method === "GET") {
      const profile = await getProfile(decodedToken.uid);
      return response.status(200).json(buildProfileResponse(profile, ceoConfig));
    }

    const ops = readProfileOps(await readJsonBody(request));
    const profile = await getProfile(decodedToken.uid);
    const updated = applyOps(profile, ops, { source: "user_edit" });
    await saveProfile(decodedToken.uid, updated);
    return response
      .status(200)
      .json(buildProfileResponse(updated, { profileUpdatedAt: new Date() }));
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/ceo/profile",
      error,
      "Unable to read or update the CEO Agent profile."
    );
  }
}

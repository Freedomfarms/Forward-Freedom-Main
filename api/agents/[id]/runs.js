import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { withUserContext } from "../../../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../../server/http/rateLimit.js";
import { readPathParam } from "../../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { AgentError } from "../../../server/agents/errors.js";
import {
  respondAgentApiError,
  serializeAgentRun,
} from "../../../server/agents/apiHelpers.js";

// GET /api/agents/:id/runs?limit=20&before=<iso> — paginated run history for
// one agent (newest first). Output ciphertext is never included here; the
// single-run endpoint serves the decrypted detail view.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function readLimit(request) {
  const raw = Number(request.query?.limit);
  if (!Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_LIMIT);
}

function readBefore(request) {
  const raw = request.query?.before;
  if (raw == null || raw === "") return null;
  const parsed = new Date(String(raw));
  if (Number.isNaN(parsed.getTime())) {
    throw new AgentError("before must be a valid ISO-8601 timestamp.", "INVALID_AGENT_PAYLOAD", 400);
  }
  return parsed;
}

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method !== "GET") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const agentId = readPathParam(request, "id");
    if (!agentId) {
      throw new AgentError("An agent id is required.", "INVALID_AGENT_PAYLOAD", 400);
    }
    const limit = readLimit(request);
    const before = readBefore(request);

    const runs = await withUserContext(decodedToken.uid, async (tx) => {
      // RLS scopes the transaction; the explicit userId check confirms this
      // agent belongs to the caller before any run rows are read.
      const agent = await tx.agentConfig.findFirst({
        where: { id: agentId, userId: decodedToken.uid },
        select: { id: true },
      });
      if (!agent) {
        throw new AgentError("Agent not found.", "AGENT_NOT_FOUND", 404);
      }
      return tx.agentRun.findMany({
        where: {
          userId: decodedToken.uid,
          agentConfigId: agent.id,
          ...(before ? { startedAt: { lt: before } } : {}),
        },
        orderBy: { startedAt: "desc" },
        take: limit,
      });
    });

    return response.status(200).json({
      runs: runs.map((run) => serializeAgentRun(run)),
      hasMore: runs.length === limit,
    });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/[id]/runs",
      error,
      "Unable to list the agent's runs."
    );
  }
}

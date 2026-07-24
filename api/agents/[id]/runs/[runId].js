import { authenticateRequest } from "../../../../server/auth/verifyAuth.js";
import { withUserContext } from "../../../../server/db/prisma.js";
import { decrypt } from "../../../../server/security/envelope.js";
import { enforceRateLimit, generalApiRateLimit } from "../../../../server/http/rateLimit.js";
import { readPathParam } from "../../../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../../../server/http/responseHelpers.js";
import { AgentError } from "../../../../server/agents/errors.js";
import {
  respondAgentApiError,
  serializeAgentRun,
} from "../../../../server/agents/apiHelpers.js";
import {
  buildRunEmailContent,
  sendAgentReportEmailOrThrow,
} from "../../../../server/agents/emailDelivery.js";

// GET  /api/agents/:id/runs/:runId — one run with the decrypted full output
//      for the detail view. This is the only endpoint that returns run output.
// POST /api/agents/:id/runs/:runId — email this run's report to the user's
//      own VERIFIED account address ("Email me this run"). The recipient is
//      never a parameter; unverified accounts are rejected with a clear error.

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!["GET", "POST"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const agentId = readPathParam(request, "id");
    const runId = readPathParam(request, "runId");
    if (!agentId || !runId) {
      throw new AgentError("An agent id and run id are required.", "INVALID_AGENT_PAYLOAD", 400);
    }

    const { run, agentConfig } = await withUserContext(decodedToken.uid, async (tx) => ({
      run: await tx.agentRun.findFirst({
        where: { id: runId, agentConfigId: agentId, userId: decodedToken.uid },
      }),
      agentConfig: await tx.agentConfig.findFirst({
        where: { id: agentId, userId: decodedToken.uid },
        select: { id: true, name: true, agentType: true },
      }),
    }));
    if (!run || !agentConfig) {
      throw new AgentError("Run not found.", "RUN_NOT_FOUND", 404);
    }

    if (request.method === "GET") {
      return response.status(200).json({ run: serializeAgentRun(run, { includeOutput: true }) });
    }

    // POST — email this run's report to the verified account address.
    let output = null;
    if (run.outputCiphertext) {
      try {
        output = decrypt(run.outputCiphertext);
      } catch {
        output = null;
      }
    }
    if (!output && !run.summary) {
      throw new AgentError(
        "This run has no report to email (no output or summary was recorded).",
        "RUN_HAS_NO_OUTPUT",
        400
      );
    }

    const { subject, body, html } = buildRunEmailContent({
      agentName: agentConfig.name,
      agentType: agentConfig.agentType,
      run,
      output,
    });
    const result = await sendAgentReportEmailOrThrow({
      userId: decodedToken.uid,
      subject,
      body,
      html,
    });
    return response.status(200).json({ emailed: true, status: result.status });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/[id]/runs/[runId]",
      error,
      "Unable to load or email the run."
    );
  }
}

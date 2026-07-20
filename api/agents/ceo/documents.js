import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { withUserContext } from "../../../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../../server/http/rateLimit.js";
import { readJsonBody, readPathParam } from "../../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { AgentError } from "../../../server/agents/errors.js";
import {
  ensureCeoAgentConfig,
  respondAgentApiError,
} from "../../../server/agents/apiHelpers.js";
import {
  createCeoDocuments,
  deleteCeoDocument,
  listCeoDocuments,
  readDocumentInputs,
} from "../../../server/agents/documents.js";

// GET    /api/agents/ceo/documents
// POST   /api/agents/ceo/documents  { documents: [{ filename, mimeType, content }] }
// DELETE /api/agents/ceo/documents/:id  (id via query/params)

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!["GET", "POST", "DELETE"].includes(request.method || "")) {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const ceoConfig = await withUserContext(decodedToken.uid, (tx) =>
      ensureCeoAgentConfig(tx, decodedToken.uid)
    );

    if (request.method === "GET") {
      const documents = await listCeoDocuments(decodedToken.uid);
      return response.status(200).json({ documents });
    }

    if (request.method === "DELETE") {
      const documentId =
        readPathParam(request, "id") ||
        (typeof request.query?.id === "string" ? request.query.id.trim() : "");
      if (!documentId) {
        throw new AgentError("A document id is required.", "INVALID_AGENT_PAYLOAD", 400);
      }
      const result = await deleteCeoDocument(decodedToken.uid, documentId);
      return response.status(200).json(result);
    }

    const payload = await readJsonBody(request);
    const inputs = readDocumentInputs(payload?.documents);
    if (!inputs.length) {
      throw new AgentError("Upload at least one document.", "INVALID_AGENT_PAYLOAD", 400);
    }
    const documents = await createCeoDocuments(decodedToken.uid, ceoConfig.id, inputs);
    return response.status(200).json({ documents });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/agents/ceo/documents",
      error,
      "Unable to manage CEO Agent documents."
    );
  }
}

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { withUserContext } from "../../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { readPathParam } from "../../server/http/requestHelpers.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { AgentError } from "../../server/agents/errors.js";
import {
  respondAgentApiError,
  serializeNotification,
} from "../../server/agents/apiHelpers.js";

// PATCH /api/notifications/:id — mark one notification read (stamps readAt).

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method !== "PATCH") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const notificationId = readPathParam(request, "id");
    if (!notificationId) {
      throw new AgentError("A notification id is required.", "INVALID_AGENT_PAYLOAD", 400);
    }

    const notification = await withUserContext(decodedToken.uid, async (tx) => {
      const existing = await tx.notification.findFirst({
        where: { id: notificationId, userId: decodedToken.uid },
      });
      if (!existing) {
        throw new AgentError("Notification not found.", "NOTIFICATION_NOT_FOUND", 404);
      }
      if (existing.readAt) return existing;
      return tx.notification.update({
        where: { id: existing.id },
        data: { readAt: new Date() },
      });
    });

    return response.status(200).json({ notification: serializeNotification(notification) });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/notifications/[id]",
      error,
      "Unable to update the notification."
    );
  }
}

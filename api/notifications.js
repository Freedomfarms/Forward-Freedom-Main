import { authenticateRequest } from "../server/auth/verifyAuth.js";
import { withUserContext } from "../server/db/prisma.js";
import { enforceRateLimit, generalApiRateLimit } from "../server/http/rateLimit.js";
import { applySecurityHeaders } from "../server/http/responseHelpers.js";
import {
  respondAgentApiError,
  serializeNotification,
} from "../server/agents/apiHelpers.js";

// GET /api/notifications?unreadOnly=true — the user's recent notifications
// (self-notifications only by design; agents can never notify anyone else).

const NOTIFICATION_LIMIT = 50;

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (request.method !== "GET") {
    return response.status(405).json({ error: true, message: "Method not allowed." });
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  try {
    const decodedToken = await authenticateRequest(request);
    const unreadOnly = request.query?.unreadOnly === "true" || request.query?.unreadOnly === "1";

    const notifications = await withUserContext(decodedToken.uid, (tx) =>
      tx.notification.findMany({
        where: { userId: decodedToken.uid, ...(unreadOnly ? { readAt: null } : {}) },
        orderBy: { createdAt: "desc" },
        take: NOTIFICATION_LIMIT,
      })
    );

    return response.status(200).json({
      notifications: notifications.map(serializeNotification),
    });
  } catch (error) {
    return respondAgentApiError(
      response,
      "api/notifications",
      error,
      "Unable to list notifications."
    );
  }
}

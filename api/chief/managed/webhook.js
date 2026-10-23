import { acknowledgeSupervisor } from "../../../server/chief/managed/drainTarget.js";
import { handleManagedWebhook } from "../../../server/chief/managed/handlers.js";
import {
  createUserStore,
  findRunByProviderSession,
} from "../../../server/chief/managed/prismaStore.js";
import { enforceRateLimit, generalApiRateLimit } from "../../../server/http/rateLimit.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  return handleManagedWebhook(request, response, {
    storeFor: (userId) => createUserStore({ userId }),
    findRunBySession: (sessionId) => findRunByProviderSession(sessionId),
    dispatch: () => acknowledgeSupervisor(),
  });
}

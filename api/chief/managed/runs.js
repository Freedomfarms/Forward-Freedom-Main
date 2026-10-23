import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { acknowledgeSupervisor } from "../../../server/chief/managed/drainTarget.js";
import { handleManagedRunStart } from "../../../server/chief/managed/handlers.js";
import { createUserStore } from "../../../server/chief/managed/prismaStore.js";
import { enforceRateLimit, generalApiRateLimit } from "../../../server/http/rateLimit.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";

export const config = { maxDuration: 60 };

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  return handleManagedRunStart(request, response, {
    authenticate: authenticateRequest,
    storeFor: (userId) => createUserStore({ userId }),
    dispatch: () => acknowledgeSupervisor(),
  });
}

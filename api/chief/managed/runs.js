import { authenticateRequest } from "../../../server/auth/verifyAuth.js";
import { createAnthropicManagedClient } from "../../../server/chief/managed/client.js";
import { drainHeaders, drainTarget } from "../../../server/chief/managed/drainTarget.js";
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
    client: process.env.ANTHROPIC_API_KEY
      ? createAnthropicManagedClient({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null,
    selfPost: async () => {
      const url = drainTarget();
      if (!url || !process.env.CHIEF_DRAIN_SECRET) return null;
      const downstream = await fetch(url, { method: "POST", headers: drainHeaders(1) });
      return { status: downstream.status };
    },
  });
}

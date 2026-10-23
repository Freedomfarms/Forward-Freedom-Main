import { handleManagedDrain } from "../../../server/chief/managed/handlers.js";
import { applySecurityHeaders } from "../../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../../server/http/rateLimit.js";
import { createAnthropicManagedClient } from "../../../server/chief/managed/client.js";
import { createUserStore, listClaimableJobs } from "../../../server/chief/managed/prismaStore.js";
import { drainHeaders, drainTarget } from "../../../server/chief/managed/drainTarget.js";

export const config = { maxDuration: 60 };

export default async function handler(request, response) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  return handleManagedDrain(request, response, {
    storeFor: (userId) => createUserStore({ userId }),
    listClaimable: (now) => listClaimableJobs(now),
    client: process.env.ANTHROPIC_API_KEY
      ? createAnthropicManagedClient({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null,
    selfPost: async ({ depth }) => postDrain(depth),
  });
}

async function postDrain(depth) {
  const url = drainTarget();
  if (!url || !process.env.CHIEF_DRAIN_SECRET) return null;
  const response = await fetch(url, {
    method: "POST",
    headers: drainHeaders(depth),
  });
  return { status: response.status };
}

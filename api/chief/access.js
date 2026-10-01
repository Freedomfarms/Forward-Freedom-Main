// GET /api/chief/access — money and web as the room may display them.
// On, off, and unavailable are different. A failed read is unavailable.
// The body is not accepted. This route does not change grants or flags.

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { loadCapabilityPolicy } from "../../server/chief/security/grants.js";
import { PrismaModuleAccess } from "../../server/chief/security/module-access.js";
import {
  projectMoneyAccess,
  projectWebAccess,
  webSearchGranted,
} from "../../server/chief/security/room-access.js";
import { resolveWebSearchCredential } from "../../server/chief/tools/web-search.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

export async function handleChiefRoomAccess(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;
  if (request.method !== "GET") {
    response.status(405).json({ error: "GET required" });
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    response.status(error.status || 401).json({ error: error.message || "Unauthorized" });
    return;
  }
  if (!userId) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  const readMoney = deps.readMoney ?? ((id) => new PrismaModuleAccess().isModule02ReadEnabled(id));
  const loadPolicy = deps.loadPolicy ?? loadCapabilityPolicy;
  const credentialPresent =
    typeof deps.credentialPresent === "boolean"
      ? deps.credentialPresent
      : Boolean(resolveWebSearchCredential());

  let money;
  try {
    money = projectMoneyAccess({ enabled: await readMoney(userId), readable: true });
  } catch {
    money = projectMoneyAccess({ readable: false });
  }

  let web;
  try {
    const policy = await loadPolicy(userId);
    web = projectWebAccess({
      granted: webSearchGranted(policy),
      credentialPresent,
      readable: true,
    });
  } catch {
    web = projectWebAccess({ readable: false });
  }

  response.status(200).json({ money, web });
}

export default function handler(request, response) {
  return handleChiefRoomAccess(request, response);
}

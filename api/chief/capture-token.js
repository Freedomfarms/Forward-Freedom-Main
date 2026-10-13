// Signed-in Freedom OS user manages the live-capture token.
// The plaintext token is returned only from action "issue".

import { authenticateRequest } from "../../server/auth/verifyAuth.js";
import { PrismaCaptureCredential } from "../../server/chief/archive/captureStore.js";
import { createCaptureToken } from "../../server/chief/archive/captureToken.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "1mb",
    },
  },
};

function fail(response, status, code) {
  response.status(status).json({ error: "Capture settings were not changed.", code });
}

export async function handleCaptureToken(request, response, deps = {}) {
  applySecurityHeaders(response);
  const limit = deps.enforceRateLimit ?? enforceRateLimit;
  if (!(await limit(request, response, generalApiRateLimit))) return;

  const method = request.method;
  if (method !== "GET" && method !== "POST") {
    response.status(405).json({ error: "GET or POST required", code: "REJECTED" });
    return;
  }

  const authenticate = deps.authenticate ?? authenticateRequest;
  let userId;
  try {
    userId = (await authenticate(request)).uid;
  } catch (error) {
    fail(response, error.status || 401, "AUTH");
    return;
  }
  if (!userId) {
    fail(response, 401, "AUTH");
    return;
  }

  const credentials = deps.credentials ?? new PrismaCaptureCredential();
  const now = deps.now ?? new Date();
  try {
    if (method === "GET") {
      response.status(200).json(await credentials.status(userId));
      return;
    }
    const action = request.body?.action;
    if (action === "issue") {
      const token = createCaptureToken(userId);
      const status = await credentials.issue(userId, token, now);
      response.status(200).json({ ...status, token });
      return;
    }
    if (action === "revoke") {
      response.status(200).json(await credentials.revoke(userId, now));
      return;
    }
    if (action === "update") {
      response.status(200).json(
        await credentials.updateControls(
          userId,
          {
            claudeEnabled: request.body?.claudeEnabled,
            chatgptEnabled: request.body?.chatgptEnabled,
            paused: request.body?.paused,
          },
          now
        )
      );
      return;
    }
    fail(response, 400, "REJECTED");
  } catch {
    fail(response, 500, "STORE");
  }
}

export default function handler(request, response) {
  return handleCaptureToken(request, response);
}

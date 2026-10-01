// UI client for the per-user Module 02 read switch. The same
// /api/chief/module-access record is what CHIEF's module02_access_set writes.

import { ApiRequestError, buildAuthenticatedHeaders, parseApiResponse } from "./api.js";
import { module02AccessPayload } from "./module02AccessCopy.js";

async function module02Json(user, { method, body } = {}) {
  const response = await fetch("/api/chief/module-access", {
    method,
    headers: await buildAuthenticatedHeaders(body ? { "Content-Type": "application/json" } : {}, {
      user,
    }),
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await parseApiResponse(response);
  if (typeof payload?.module02Read !== "boolean") {
    throw new ApiRequestError("CHIEF access could not be loaded.", { status: response.status });
  }
  return { module02Read: payload.module02Read === true, writeAccess: false };
}

export function fetchModule02ChiefAccess(user) {
  return module02Json(user, { method: "GET" });
}

export function saveModule02ChiefAccess(user, enabled) {
  return module02Json(user, { method: "POST", body: module02AccessPayload(enabled) });
}

// UI client for the per-user Freedom Financial read switch. The same
// /api/chief/module-access record is what CHIEF's freedom_financial_access_set writes.

import { ApiRequestError, buildAuthenticatedHeaders, parseApiResponse } from "./api.js";
import { freedomFinancialAccessPayload } from "./freedomFinancialAccessCopy.js";

async function freedomFinancialAccessJson(user, { method, body } = {}) {
  const response = await fetch("/api/chief/module-access", {
    method,
    headers: await buildAuthenticatedHeaders(body ? { "Content-Type": "application/json" } : {}, {
      user,
    }),
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await parseApiResponse(response);
  if (typeof payload?.freedomFinancialRead !== "boolean") {
    throw new ApiRequestError("CHIEF access could not be loaded.", { status: response.status });
  }
  return { freedomFinancialRead: payload.freedomFinancialRead === true, writeAccess: false };
}

export function fetchFreedomFinancialChiefAccess(user) {
  return freedomFinancialAccessJson(user, { method: "GET" });
}

export function saveFreedomFinancialChiefAccess(user, enabled) {
  return freedomFinancialAccessJson(user, {
    method: "POST",
    body: freedomFinancialAccessPayload(enabled),
  });
}

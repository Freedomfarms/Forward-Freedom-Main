// HTTP boundary for the self-report ingress.
//
// Key management uses the signed-in Freedom OS user. The report itself uses
// only the issued key. A Firebase session cannot write an observation, and
// the report body cannot choose userId, trust, or platform provenance.

import { authenticateRequest, readBearerToken } from "../../auth/verifyAuth.js";
import { withUserContext } from "../../db/prisma.js";
import { applySecurityHeaders, assertMethod } from "../../http/responseHelpers.js";
import {
  enforceRateLimit,
  workforceReportKeyRateLimit,
  workforceReportRateLimit,
} from "../../http/rateLimit.js";
import { acceptSelfReport, ReportRejected, selfReportCoverage } from "./ingest.js";
import { createReportToken, parseReportToken } from "./reportKey.js";
import { revokeReportKey, saveReportKey } from "./store.js";

const BODY_MAX = 20_000;
const STORED_MESSAGE = "Workforce report could not be stored.";

function fail(response, status, message) {
  response.status(status).json({ error: true, message });
}

function bodyTooLarge(body) {
  if (body == null) return false;
  try {
    return JSON.stringify(body).length > BODY_MAX;
  } catch {
    return true;
  }
}

function failure(error) {
  if (error instanceof ReportRejected) return { status: error.status, message: error.message };
  if (error?.status === 503 || error?.status === 403) {
    return { status: error.status, message: error.message || STORED_MESSAGE };
  }
  if (error?.message === "workforce binding is not active") {
    return { status: 403, message: "Workforce binding is not active." };
  }
  return { status: 500, message: STORED_MESSAGE };
}

export function reportKeyView(binding) {
  const active = Boolean(binding && binding.status === "ACTIVE" && binding.reportKeyHash);
  return {
    active,
    issuedAt:
      active && binding.reportKeyIssuedAt
        ? new Date(binding.reportKeyIssuedAt).toISOString()
        : null,
    source: "self_report",
    trust: "untrusted",
    ...selfReportCoverage(),
  };
}

export async function handleWorkforceReport(request, response, deps = {}) {
  applySecurityHeaders(response);
  const limit = deps.enforceRateLimit ?? enforceRateLimit;
  if (!(await limit(request, response, deps.rateLimit ?? workforceReportRateLimit))) return;
  if (!assertMethod(request, response, "POST")) return;

  const token = readBearerToken(request);
  const parsed = parseReportToken(token);
  if (!parsed || bodyTooLarge(request.body)) {
    if (!parsed) {
      fail(response, 401, "Workforce report was not accepted.");
      return;
    }
    fail(response, 413, "Workforce report is too large.");
    return;
  }

  const run = deps.withUser ?? withUserContext;
  try {
    const result = await run(parsed.userId, (tx) =>
      acceptSelfReport(tx, token, request.body, { encrypt: deps.encrypt, now: deps.now })
    );
    response.status(200).json({
      accepted: true,
      duplicate: result.duplicate === true,
      source: "self_report",
      trust: "untrusted",
    });
  } catch (error) {
    const outcome = failure(error);
    fail(response, outcome.status, outcome.message);
  }
}

async function signedInUser(request, deps) {
  const authenticate = deps.authenticate ?? authenticateRequest;
  const decoded = await authenticate(request);
  const userId = decoded?.uid;
  if (!userId) {
    const error = new Error("Unauthorized");
    error.status = 401;
    throw error;
  }
  return userId;
}

export async function handleWorkforceReportKey(request, response, deps = {}) {
  applySecurityHeaders(response);
  const limit = deps.enforceRateLimit ?? enforceRateLimit;
  if (!(await limit(request, response, deps.rateLimit ?? workforceReportKeyRateLimit))) return;
  if (!assertMethod(request, response, "GET", "POST", "DELETE")) return;

  let userId;
  try {
    userId = await signedInUser(request, deps);
  } catch (error) {
    fail(response, error.status || 401, error.message || "Unauthorized");
    return;
  }

  const run = deps.withUser ?? withUserContext;
  try {
    if (request.method === "GET") {
      const binding = await run(userId, (tx) =>
        tx.workforceBinding.findUnique({ where: { userId } })
      );
      response.status(200).json(reportKeyView(binding));
      return;
    }
    if (request.method === "DELETE") {
      await run(userId, (tx) => revokeReportKey(tx, userId));
      response.status(200).json({ active: false, source: "self_report", trust: "untrusted" });
      return;
    }
    const now = deps.now ?? new Date();
    const reportKey = createReportToken(userId);
    await run(userId, (tx) => saveReportKey(tx, userId, reportKey, now));
    response.status(201).json({
      reportKey,
      source: "self_report",
      trust: "untrusted",
      ...selfReportCoverage(),
    });
  } catch (error) {
    const outcome = failure(error);
    fail(response, outcome.status, outcome.message);
  }
}

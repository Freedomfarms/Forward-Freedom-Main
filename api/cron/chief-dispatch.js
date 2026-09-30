// GET /api/cron/chief-dispatch — CHIEF scheduler tick (vercel.json cron).
//
// BUILD NEW thin shell (docs/adr/0005-chief-scheduler-tick.md): cron auth,
// then runChiefTick. Every due task becomes one TurnMachine turn with caller
// kind "schedule". Nothing here calls a model or a tool.
//
// Authenticated by CRON_SECRET ("Authorization: Bearer <secret>", which
// Vercel Cron sends when CRON_SECRET is set, or ?secret=). Fails closed with
// 503 when CRON_SECRET is unset.

import crypto from "node:crypto";

import { readBearerToken } from "../../server/auth/verifyAuth.js";
import { createChiefTurnServices } from "../../server/chief/context/wire.js";
import { PrismaBudgetStore } from "../../server/chief/models/budget.js";
import { createModelEngine } from "../../server/chief/models/engine.js";
import { PrismaFactStore } from "../../server/chief/memory/facts.js";
import { PrismaCheckpointStore } from "../../server/chief/runtime/checkpoint.js";
import { PrismaTaskStore } from "../../server/chief/scheduler/store.js";
import { runChiefTick } from "../../server/chief/scheduler/tick.js";
import { PrismaAuditLog } from "../../server/chief/security/audit.js";
import { createChiefTooling } from "../../server/chief/tools/builtin.js";
import { enforceRateLimit, generalApiRateLimit } from "../../server/http/rateLimit.js";
import { applySecurityHeaders } from "../../server/http/responseHelpers.js";

function secretMatches(provided, secret) {
  const a = crypto.createHash("sha256").update(String(provided)).digest();
  const b = crypto.createHash("sha256").update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

function defaultDeps() {
  const audit = new PrismaAuditLog();
  const budget = new PrismaBudgetStore();
  const facts = new PrismaFactStore();
  const checkpointStore = new PrismaCheckpointStore();
  return {
    taskStore: new PrismaTaskStore(),
    checkpointStore,
    createEngine: () => createModelEngine({ budget }),
    createTooling: ({ userId }) => createChiefTooling({ userId, audit, stores: { facts } }),
    createTurnServices: ({ engine, policy }) =>
      createChiefTurnServices({
        facts,
        engine,
        checkpointStore,
        capabilityPolicy: policy ?? null,
      }),
    audit,
  };
}

export async function handleChiefDispatch(request, response, deps = {}) {
  applySecurityHeaders(response);
  if (request.method !== "GET") {
    response.status(405).json({ error: "GET required" });
    return;
  }
  if (!(await enforceRateLimit(request, response, generalApiRateLimit))) return;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    response.status(503).json({ error: "CHIEF dispatch is not configured (missing CRON_SECRET)" });
    return;
  }
  const provided = readBearerToken(request) || request.query?.secret || "";
  if (!provided || !secretMatches(provided, secret)) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const report = await runChiefTick(deps.taskStore ? deps : { ...defaultDeps(), ...deps });
    response.status(200).json({ ok: true, ...report });
  } catch (error) {
    console.error("[chief/dispatch]", error?.name || "Error");
    response.status(error?.status === 503 ? 503 : 500).json({ error: "CHIEF tick failed" });
  }
}

export default function handler(request, response) {
  return handleChiefDispatch(request, response);
}

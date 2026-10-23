import {
  PROPOSED_PROOF_LEDGER_CENTS,
  PROPOSED_PROOF_SESSION_CAP,
  SESSION_BUDGET_CENTS,
} from "./constants.js";

// Phases that open a provider session. close only releases a write lease.
export const LIVE_PHASES = Object.freeze([
  "initial",
  "continue_same_store",
  "close",
  "correct",
  "confirm",
  "close",
  "recover",
]);

const SESSION_PHASES = new Set(["initial", "continue_same_store", "correct", "confirm", "recover"]);
const WRITE_PHASES = new Set(["initial", "correct", "recover"]);

export function assessLivePrerequisites(env = {}, extras = {}) {
  const missing = [];
  if (env.CHIEF_PROOF_SPEND_APPROVED !== "1") {
    missing.push(
      "CHIEF_PROOF_SPEND_APPROVED is not 1. The live runner is implemented. The proposed cap is 5 provider sessions and 1000 cents ($10.00), and that spend is not approved."
    );
  }
  if (!env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY is unset");
  if (env.CHIEF_MANAGED_PROOF !== "1") missing.push("CHIEF_MANAGED_PROOF must be 1");
  if (!env.DATABASE_URL) missing.push("DATABASE_URL is unset");
  if (!env.DIRECT_URL) missing.push("DIRECT_URL is unset");
  if (!env.SERVICE_DATABASE_URL) {
    missing.push(
      "SERVICE_DATABASE_URL is unset. The proof writes deployment resource rows with the freedom_service role, and that connection must be part of the identity check."
    );
  }
  if (!env.CHIEF_PRODUCTION_DB_SYSTEM_ID && !env.CHIEF_PRODUCTION_SUPABASE_PROJECT_REF) {
    missing.push(
      "CHIEF_PRODUCTION_DB_SYSTEM_ID is unset. Set it from the production owner role, or set CHIEF_PRODUCTION_SUPABASE_PROJECT_REF if pg_control_system() is denied."
    );
  }
  if (!env.FFF_ENCRYPTION_KEYS) missing.push("FFF_ENCRYPTION_KEYS is unset");
  if (!env.FFF_ENCRYPTION_ACTIVE_VERSION) missing.push("FFF_ENCRYPTION_ACTIVE_VERSION is unset");
  if (!env.CHIEF_PROOF_USER_ID) {
    missing.push(
      'CHIEF_PROOF_USER_ID is unset. It must be an existing "User".id in the isolated database.'
    );
  }
  if (!env.CHIEF_SUPERVISOR_URL) {
    missing.push(
      "CHIEF_SUPERVISOR_URL is unset. The bounded experiment uses a separate Cursor cloud supervisor process, not the request that started the run."
    );
  }
  if (!env.CHIEF_DRAIN_SECRET) missing.push("CHIEF_DRAIN_SECRET is unset");
  if (!env.CHIEF_SUPERVISOR_MODE || env.CHIEF_SUPERVISOR_MODE !== "embedded") {
    missing.push(
      'CHIEF_SUPERVISOR_MODE must be "embedded" for the bounded Cursor cloud experiment.'
    );
  }
  if (extras.identity && !extras.identity.ok) {
    for (const failure of extras.identity.failures || [])
      missing.push(`database identity: ${failure}`);
  }
  if (extras.identity && env.SERVICE_DATABASE_URL && extras.identity.serviceChecked !== true) {
    missing.push("SERVICE_DATABASE_URL was set but the identity check did not probe it");
  }
  if (extras.baseline && !extras.baseline.ok) {
    for (const failure of extras.baseline.failures || [])
      missing.push(`schema baseline: ${failure}`);
  }
  if (extras.readiness && !extras.readiness.ok) {
    for (const failure of extras.readiness.failures || ["schema readiness failed"]) {
      missing.push(`schema readiness: ${failure}`);
    }
  }
  if (extras.user && extras.user.ok === false) missing.push(...(extras.user.missing || []));
  return missing;
}

export function assessProofUser(row, userId) {
  if (!userId) {
    return {
      ok: false,
      missing: ['CHIEF_PROOF_USER_ID is unset. It must be an existing "User".id.'],
    };
  }
  if (!row) {
    return {
      ok: false,
      missing: [
        'CHIEF_PROOF_USER_ID is not a row in "User" on the isolated database. Insert that user before the live experiment. Do not use a production user.',
      ],
    };
  }
  return { ok: true, missing: [] };
}

export async function executeLiveProof({
  store,
  userId,
  phases = LIVE_PHASES,
  dispatch,
  queue = null,
  readRun,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 120_000,
  sessionCap = PROPOSED_PROOF_SESSION_CAP,
  ledgerCents = PROPOSED_PROOF_LEDGER_CENTS,
  sessionBudgetCents = Number(SESSION_BUDGET_CENTS),
  liveProvider = false,
}) {
  const queueRun = queue;
  if (!queueRun) throw new Error("executeLiveProof requires queue");
  let projectId = null;
  let writeOwnerRunId = null;
  let sessionsReserved = 0;
  const evidence = [];
  for (const phase of phases) {
    if (SESSION_PHASES.has(phase)) {
      const nextSessions = sessionsReserved + 1;
      const nextLedger = nextSessions * sessionBudgetCents;
      if (nextSessions > sessionCap || nextLedger > ledgerCents) {
        return {
          ok: false,
          acceptance: liveProvider ? "live_stopped" : "runner_stopped",
          mocked: !liveProvider,
          reason: "proposed_cost_cap",
          sessionsReserved,
          ledgerCents,
          sessionCap,
          evidence,
        };
      }
      sessionsReserved = nextSessions;
    }
    const queued = await queueRun(store, {
      userId,
      phase,
      projectId,
      priorRunId: writeOwnerRunId,
      title: "Goat hay feeder",
    });
    projectId = queued.project.id;
    const ack = await dispatch({ runId: queued.run.id, phase });
    if (!ack?.accepted) {
      return {
        ok: false,
        acceptance: liveProvider ? "live_refused" : "runner_refused",
        mocked: !liveProvider,
        reason: ack?.reason || "dispatch_not_acknowledged",
        runId: queued.run.id,
        evidence,
      };
    }
    const run = await waitForRun({ readRun, runId: queued.run.id, phase, wait, timeoutMs });
    evidence.push(publicEvidence(phase, run));
    if (run.status === "failed") {
      return {
        ok: false,
        acceptance: liveProvider ? "live_failed" : "runner_failed",
        mocked: !liveProvider,
        reason: run.lastError || "phase_failed",
        sessionsReserved,
        evidence,
      };
    }
    if (WRITE_PHASES.has(phase)) writeOwnerRunId = queued.run.id;
  }
  return {
    ok: true,
    acceptance: liveProvider ? "live" : "runner_exercised_with_injected_client",
    mocked: !liveProvider,
    sessionsReserved,
    ledgerCents,
    sessionCap,
    evidence,
  };
}

async function waitForRun({ readRun, runId, phase, wait, timeoutMs }) {
  const started = Date.now();
  let latest;
  while (Date.now() - started <= timeoutMs) {
    latest = await readRun(runId);
    if (latest && terminal(phase, latest)) return latest;
    await wait(15);
  }
  const error = new Error(`supervisor did not finish phase ${phase} before ${timeoutMs}ms`);
  error.status = 504;
  throw error;
}

function terminal(phase, run) {
  if (run.status === "failed") return true;
  if (phase === "close") return run.status === "closed";
  return run.status === "idle" && run.synced === true;
}

function publicEvidence(phase, run) {
  return {
    phase,
    runId: run.id,
    status: run.status,
    providerSessionId: run.providerSessionId,
    memoryStoreId: run.memoryStoreId,
    priorStoreId: run.priorStoreId,
    promptSubmittedBy: run.promptSubmittedBy,
    skillEvidence: run.skillEvidence,
    workspaceEvidence: run.workspaceEvidence,
    modelEvidence: run.modelEvidence,
    assistantText: run.assistantText,
  };
}

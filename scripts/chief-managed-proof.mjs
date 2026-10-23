import path from "node:path";
import { pathToFileURL } from "node:url";

import { PROOF_PHASES } from "../server/chief/managed/constants.js";
import {
  LIVE_PHASES,
  assessLivePrerequisites,
  assessProofUser,
  executeLiveProof,
} from "../server/chief/managed/liveProof.js";
import { redactSecrets } from "../server/chief/managed/redact.js";

const live = process.argv.includes("--live");

export async function runProofCommand(env = process.env, deps = {}) {
  if (!liveRequested(deps, env)) {
    return {
      exitCode: 0,
      body: {
        mode: "dry_run",
        live: false,
        acceptance: "mocked_only",
        phases: LIVE_PHASES,
        knownPhases: PROOF_PHASES,
        note: "Dry run only. This does not call Anthropic or migrate a database. --live runs the implemented runner after the prerequisites below are present.",
      },
    };
  }
  const missing = assessLivePrerequisites(env);
  if (missing.length) {
    return { exitCode: 3, body: { acceptance: "live_refused", implemented: true, missing } };
  }
  const identify =
    deps.identify || (await import("./chief-proof-db-identity.mjs")).identifyProofDatabase;
  const checkReadiness =
    deps.checkReadiness || (await import("./chief-proof-db-readiness.mjs")).checkProofReadiness;
  const identity = await identify(env);
  const readiness = identity.ok
    ? await checkReadiness(env, identity)
    : { ok: false, stage: "identity", identity, baseline: null, readiness: null };
  const user = identity.ok
    ? assessProofUser(await (deps.lookupUser || lookupProofUser)(env), env.CHIEF_PROOF_USER_ID)
    : { ok: true, missing: [] };
  const blocked = assessLivePrerequisites(env, {
    identity,
    baseline: readiness.baseline,
    readiness: readiness.readiness,
    user,
  });
  if (blocked.length) {
    return { exitCode: 2, body: { acceptance: "live_refused", implemented: true, missing: blocked } };
  }
  const started = await (deps.execute || executeConfigured)(env);
  return { exitCode: started.ok ? 0 : 4, body: started };
}

async function executeConfigured(env) {
  // The embedded supervisor creates the Anthropic client and advances the job.
  // This process queues the run, waits for the kick acknowledgement, and polls.
  const { acknowledgeSupervisor } = await import("../server/chief/managed/drainTarget.js");
  const { createUserStore } = await import("../server/chief/managed/prismaStore.js");
  const { queueProofRun } = await import("../server/chief/managed/queue.js");
  const store = createUserStore({ userId: env.CHIEF_PROOF_USER_ID });
  return executeLiveProof({
    store,
    userId: env.CHIEF_PROOF_USER_ID,
    queue: queueProofRun,
    dispatch: () => acknowledgeSupervisor(env),
    readRun: (runId) => store.getRun(runId),
    liveProvider: true,
  });
}

async function lookupProofUser(env) {
  const pg = (await import("pg")).default;
  const { buildPgPoolConfig } = await import("../server/db/pgPoolConfig.js");
  const pool = new pg.Pool(buildPgPoolConfig(env.SERVICE_DATABASE_URL));
  try {
    const result = await pool.query('SELECT id FROM "User" WHERE id = $1', [
      env.CHIEF_PROOF_USER_ID,
    ]);
    return result.rows[0] || null;
  } finally {
    await pool.end();
  }
}

function liveRequested(deps, env) {
  if (typeof deps.live === "boolean") return deps.live;
  return env === process.env && process.argv.includes("--live");
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  runProofCommand(process.env, { live })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${redactSecrets(error.message)}\n`);
      process.exitCode = 4;
    });
}

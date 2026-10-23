import { SUPERVISOR_INTERVAL_MS } from "../server/chief/managed/constants.js";
import { drainHeaders, drainTarget } from "../server/chief/managed/drainTarget.js";
import { createKickServer } from "../server/chief/managed/kickServer.js";
import { redactSecrets } from "../server/chief/managed/redact.js";
import { supervise } from "../server/chief/managed/supervisor.js";

const once = process.argv.includes("--once");
const intervalMs = Number(process.env.CHIEF_SUPERVISOR_INTERVAL_MS || SUPERVISOR_INTERVAL_MS);
const mode = process.env.CHIEF_SUPERVISOR_MODE === "embedded" ? "embedded" : "http";

function log(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function httpTick() {
  const url = drainTarget();
  if (!url || !process.env.CHIEF_DRAIN_SECRET) {
    const error = new Error("CHIEF_DRAIN_SECRET and a drain or supervisor URL are required.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { ...drainHeaders(0), "x-chief-actor": "supervisor" },
  });
  return { drained: response.status };
}

async function embeddedTick() {
  const { advanceRun } = await import("../server/chief/managed/orchestrator.js");
  const { createAnthropicManagedClient } = await import("../server/chief/managed/client.js");
  const { createUserStore, listClaimableJobs } =
    await import("../server/chief/managed/prismaStore.js");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured.");
  const jobs = await listClaimableJobs(new Date());
  const client = createAnthropicManagedClient({ apiKey: process.env.ANTHROPIC_API_KEY });
  let drained = 0;
  for (const job of jobs) {
    await advanceRun({
      store: createUserStore({ userId: job.userId }),
      client,
      runId: job.runId,
      actor: "supervisor",
    });
    drained += 1;
  }
  return { drained };
}

const tick = mode === "embedded" ? embeddedTick : httpTick;

if (process.env.CHIEF_SUPERVISOR_LISTEN === "1") {
  const port = Number(process.env.CHIEF_SUPERVISOR_PORT || 8787);
  const host = process.env.CHIEF_SUPERVISOR_HOST || "127.0.0.1";
  createKickServer({
    host,
    port,
    secret: process.env.CHIEF_DRAIN_SECRET,
    onKick: () => tick(),
    onError: (message) =>
      log({ event: "supervisor_kick_failed", error: message, delayClass: "supervisor_recovery" }),
  })
    .then((listener) => {
      log({
        event: "supervisor_listen",
        host: listener.host,
        port: listener.port,
        mode,
        hosting: "temporary_cursor_cloud_process",
        durable: false,
      });
    })
    .catch((error) => {
      process.stderr.write(`${redactSecrets(error.message)}\n`);
      process.exitCode = 1;
    });
}

supervise({
  intervalMs,
  once,
  tick,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log,
}).catch((error) => {
  process.stderr.write(`${redactSecrets(error.message)}\n`);
  process.exitCode = 1;
});

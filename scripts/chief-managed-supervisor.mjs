import http from "node:http";

import { SUPERVISOR_INTERVAL_MS } from "../server/chief/managed/constants.js";
import { drainHeaders, drainTarget } from "../server/chief/managed/drainTarget.js";
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
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
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
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/kick") {
      try {
        const result = await tick();
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: true, drained: result.drained }));
      } catch (error) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ accepted: false, error: redactSecrets(error.message) }));
      }
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(port, () => {
    log({ event: "supervisor_listen", port, mode, durable: false });
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

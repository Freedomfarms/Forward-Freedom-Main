import { SUPERVISOR_INTERVAL_MS } from "./constants.js";
import { redactSecrets } from "./redact.js";

export async function supervise({
  intervalMs = SUPERVISOR_INTERVAL_MS,
  once = false,
  tick,
  sleep,
  log = () => {},
}) {
  let running = true;
  while (running) {
    const started = Date.now();
    try {
      const result = await tick();
      log({
        event: "supervisor_tick",
        ok: true,
        delayClass: "supervisor_recovery",
        ms: Date.now() - started,
        drained: result?.drained ?? null,
      });
    } catch (error) {
      log({
        event: "supervisor_tick",
        ok: false,
        delayClass: "supervisor_recovery",
        ms: Date.now() - started,
        error: redactSecrets(error.message),
      });
    }
    if (once) running = false;
    else await sleep(intervalMs);
  }
}

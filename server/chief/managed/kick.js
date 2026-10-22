import { SLICE_BUDGET_MS } from "./constants.js";
import { advanceRun } from "./orchestrator.js";

// The start route awaits this before it responds. Self-POST runs only after
// advanceRun has already persisted the job, and the await is an optimization.
// The 30-second supervisor is the recovery path when this chain stops.

export async function acceptRun({
  store,
  client,
  runId,
  actor = "awaited_start",
  budgetMs = SLICE_BUDGET_MS,
  now = new Date(),
  routeStartedAt = null,
  selfPost = null,
}) {
  const advanced = await advanceRun({
    store,
    client,
    runId,
    actor,
    budgetMs,
    now,
    routeStartedAt,
  });
  if (!advanced.yielded || !selfPost) return { ...advanced, chained: null };
  const chained = await selfPost({ runId });
  return { ...advanced, chained };
}

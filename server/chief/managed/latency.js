export function classifyDelay(actor) {
  return actor === "supervisor" ? "supervisor_recovery" : "normal";
}

export function buildLatencySample({
  run,
  actor,
  now,
  routeStartedAt = null,
  processedAt = null,
  firstTextAt = null,
  completedAt = null,
  phase,
}) {
  const observedAt = now;
  const processed = processedAt ? new Date(processedAt) : null;
  const pollDelayMs = processed ? Math.max(0, observedAt.getTime() - processed.getTime()) : null;
  return {
    userId: run.userId,
    runId: run.id,
    kind: run.promptClass === "resumed" ? "resumed" : "fresh",
    delayClass: classifyDelay(actor),
    phase,
    actor,
    startedAt: new Date(run.createdAt),
    firstTextAt: firstTextAt ? new Date(firstTextAt) : null,
    completedAt: completedAt ? new Date(completedAt) : null,
    processedAt: processed,
    observedAt,
    routeMs: routeStartedAt
      ? Math.max(0, observedAt.getTime() - new Date(routeStartedAt).getTime())
      : null,
    pollDelayMs,
    note: processed ? null : "poll-observed only; processed_at was absent",
  };
}

export function summarizeLatency(samples = []) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.kind}:${sample.delayClass}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  const summary = {};
  for (const [key, rows] of groups) {
    summary[key] = {
      count: rows.length,
      medianFirstTextMs: median(rows.map(firstTextMs).filter((value) => value != null)),
      medianCompletionMs: median(rows.map(completionMs).filter((value) => value != null)),
    };
  }
  return {
    kept: samples.length,
    dropped: 0,
    groups: summary,
    samples,
  };
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function firstTextMs(sample) {
  if (!sample.firstTextAt) return null;
  return new Date(sample.firstTextAt).getTime() - new Date(sample.startedAt).getTime();
}

function completionMs(sample) {
  if (!sample.completedAt) return null;
  return new Date(sample.completedAt).getTime() - new Date(sample.startedAt).getTime();
}

// Status poll for approved coding executions. runChiefTick is the host.
// This reads the existing WorkforceExecution ledger. It does not submit, grant,
// merge, or deploy. A missing Cursor runtime skips the poll.

import { allowlistFor } from "../agents/codingHandoff.js";
import { createCursorCloudRuntime } from "../agents/cursorCloud.js";
import { reconcileGranted } from "../agents/ledger.js";
import { HOOK_EXECUTION_UNCONFIRMED } from "../ecc/review.js";
import { fencesOutput, scanInjection } from "../security/injection.js";

const NOTABLE = new Set(["FINISHED", "ERROR", "CANCELLED", "FAILED", "COMPLETED"]);

export function codingRuntimeFor(env, executionStore, fetchImpl = globalThis.fetch) {
  const key = typeof env?.CURSOR_API_KEY === "string" ? env.CURSOR_API_KEY.trim() : "";
  if (!/^[^\s]{8,512}$/.test(key) || typeof executionStore?.adapter !== "function") return null;
  const allowlist = allowlistFor(env);
  if (!allowlist.length) return null;
  return createCursorCloudRuntime({
    apiKey: key,
    allowlist,
    ledger: executionStore.adapter(),
    fetch: fetchImpl,
  });
}

export function codingStatusLine(record, result) {
  const status = result?.status || record?.platformStatus || record?.state || "UNKNOWN";
  const pull = Array.isArray(result?.pullRequests) ? result.pullRequests[0] : null;
  const prUrl = typeof pull === "string" ? pull : typeof pull?.url === "string" ? pull.url : "";
  const finished = status === "FINISHED" ? "yes" : "no";
  const checks =
    result?.automatedChecksPassed === true
      ? "yes"
      : result?.automatedChecksPassed === false
        ? "no"
        : "not-read";
  const verified = result?.verified === true ? "yes" : "no";
  const id = record?.agentId || record?.id || "task";
  return `- ${id} status=${status} finished=${finished} pr=${prUrl || "none"} checks=${checks} verified=${verified} hook=unconfirmed`;
}

export function mergeCodingStatus(current, line) {
  const body = typeof current === "string" ? current : "";
  const heading = "## Coding status";
  const index = body.indexOf(heading);
  const head = (index >= 0 ? body.slice(0, index) : body).trimEnd();
  const existing = index >= 0 ? body.slice(index + heading.length) : "";
  const taskId = /^-\s+(\S+)/.exec(line)?.[1] || "";
  const lines = existing
    .split("\n")
    .map((item) => item.trimEnd())
    .filter((item) => item.startsWith("- "));
  const next = [];
  let replaced = false;
  for (const item of lines) {
    if (taskId && item.startsWith(`- ${taskId} `)) {
      next.push(line);
      replaced = true;
    } else {
      next.push(item);
    }
  }
  if (!replaced) next.push(line);
  const section = [heading, ...next, ""].join("\n");
  const content = head ? `${head}\n\n${section}` : `${section}`;
  return { content, changed: content.trim() !== body.trim() };
}

export function codingFollowNotice(line, result) {
  const statement =
    typeof result?.statement === "string" && !fencesOutput(scanInjection(result.statement).threatLevel)
      ? result.statement.trim().slice(0, 500)
      : "";
  return [
    "Application notice about an approved coding task. Do not quote this note and do not start another coding task.",
    "Cursor FINISHED means the run finished. Automated checks and fully verified are separate. Do not invent a security-hook result.",
    HOOK_EXECUTION_UNCONFIRMED,
    line,
    statement ? `Cursor statement: ${statement}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function notable(status, line) {
  return NOTABLE.has(status) || / pr=https?:\/\//.test(line);
}

async function interactiveSession(checkpointStore, userId) {
  if (!checkpointStore || typeof checkpointStore.listOwnedSessions !== "function") return null;
  const sessions = await checkpointStore.listOwnedSessions(userId);
  const open = (sessions || []).filter((session) => {
    if (!session || session.archivedAt) return false;
    const origin = session.context?.origin;
    return origin !== "managed-schedule" && origin !== "schedule";
  });
  open.sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt));
  return open[0] || null;
}

async function recordStatus(documentStore, userId, line) {
  if (!documentStore || typeof documentStore.list !== "function") return { changed: false };
  const rows = await documentStore.list(userId);
  const current = (rows || []).find((row) => row.path === "next-step.md");
  if (current?.deletedAt) return { changed: false, deleted: true };
  const merged = mergeCodingStatus(current?.content || "", line);
  if (!merged.changed) return { changed: false, content: current?.content || "" };
  const applied = await documentStore.applyWrite({
    userId,
    path: "next-step.md",
    content: merged.content,
    contentSha256: undefined,
    expectedSha256: current?.contentSha256 || null,
    op: current ? "update" : "insert",
  });
  if (!applied?.ok) return { changed: false, conflict: true };
  return { changed: true, content: merged.content };
}

async function enqueueFollow({ checkpointStore, jobs, userId, line, result }) {
  const session = await interactiveSession(checkpointStore, userId);
  if (!session) return { enqueued: false };
  const loaded = await checkpointStore.load(userId, session.id);
  if (!loaded?.checkpoint) return { enqueued: false };
  const checkpoint = loaded.checkpoint;
  const note = codingFollowNotice(line, result);
  const held = Array.isArray(checkpoint.context?.heldPrompts) ? checkpoint.context.heldPrompts : [];
  if (checkpoint.context?.outboundPrompt === note || held.includes(note)) return { enqueued: false };
  checkpoint.context = { ...(checkpoint.context || {}) };
  if (!checkpoint.context.outboundPrompt) checkpoint.context.outboundPrompt = note;
  else checkpoint.context.heldPrompts = [...held, note];
  await checkpointStore.saveWithEvents(userId, session.id, { checkpoint });
  if (jobs && typeof jobs.enqueue === "function") {
    await jobs.enqueue({ userId, threadId: session.id });
  }
  return { enqueued: true, sessionId: session.id };
}

async function observe(executionStore, runtime, row) {
  const record = await executionStore.get(row.userId, row.id);
  if (!record) return { skip: "missing" };
  if (record.state === "APPROVED") return { skip: "not_submitted", record };
  if (record.state === "AMBIGUOUS" || record.state === "SUBMITTING") {
    const reconciled = await reconcileGranted({
      store: executionStore,
      runtime,
      userId: record.userId,
      executionId: record.id,
    });
    const current = reconciled.record || (await executionStore.get(record.userId, record.id));
    if (!reconciled.changed || !current?.runId) return { skip: "unchanged", record: current };
    const result = await runtime.getResult(
      { agentId: current.agentId, runId: current.runId },
      { userId: current.userId }
    );
    return { record: await executionStore.get(current.userId, current.id), result };
  }
  if (!record.agentId || !record.runId) return { skip: "no_run", record };
  const result = await runtime.getResult(
    { agentId: record.agentId, runId: record.runId },
    { userId: record.userId }
  );
  return { record: await executionStore.get(record.userId, record.id), result };
}

export async function pollCodingExecutions({
  executionStore,
  runtime,
  documentStore = null,
  checkpointStore = null,
  jobs = null,
  limit = 5,
} = {}) {
  if (!executionStore || typeof executionStore.listNonterminal !== "function") {
    return { polled: 0, skipped: "no_ledger", reported: 0, enqueued: 0 };
  }
  if (!runtime || typeof runtime.getResult !== "function" || typeof runtime.lookupPlatformAgent !== "function") {
    return { polled: 0, skipped: "not_configured", reported: 0, enqueued: 0 };
  }
  const listed = await executionStore.listNonterminal(limit);
  const report = { polled: 0, skipped: null, reported: 0, enqueued: 0, unchanged: 0 };
  for (const row of listed || []) {
    report.polled += 1;
    let observed;
    try {
      observed = await observe(executionStore, runtime, row);
    } catch {
      continue;
    }
    if (!observed?.result || !observed.record) {
      report.unchanged += 1;
      continue;
    }
    const line = codingStatusLine(observed.record, observed.result);
    const saved = await recordStatus(documentStore, row.userId, line);
    if (!saved.changed) {
      report.unchanged += 1;
      continue;
    }
    report.reported += 1;
    const status = observed.result.status || observed.record.state;
    if (!notable(status, line)) continue;
    const queued = await enqueueFollow({
      checkpointStore,
      jobs,
      userId: row.userId,
      line,
      result: observed.result,
    });
    if (queued.enqueued) report.enqueued += 1;
  }
  return report;
}

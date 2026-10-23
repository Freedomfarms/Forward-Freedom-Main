import { WRITE_LEASE_MS } from "./constants.js";

export function sessionCanResume({ runStatus, providerStatus, unfinishedToolCalls }) {
  if (unfinishedToolCalls > 0) return true;
  if (runStatus === "closed") return false;
  if (providerStatus === "terminated") return false;
  return true;
}

export function canReleaseWriteOwnership(state) {
  return !sessionCanResume(state);
}

export function acquireWriteLease({
  project,
  sessionId,
  now,
  leaseMs = WRITE_LEASE_MS,
  ownerCanResume,
}) {
  if (!project || !sessionId) return { ok: false, reason: "missing_lease_subject" };
  const same = project.writeSessionId === sessionId;
  if (project.writeSessionId && !same && ownerCanResume) {
    return { ok: false, reason: "owner_can_resume" };
  }
  const leaseGeneration = same ? project.leaseGeneration : project.leaseGeneration + 1;
  return {
    ok: true,
    writeSessionId: sessionId,
    leaseGeneration,
    writeLeaseExpiresAt: new Date(now.getTime() + leaseMs),
  };
}

export function authorizeCommit({ project, writeSessionId, leaseGeneration, now }) {
  if (!project) return { ok: false, reason: "missing_project" };
  if (project.writeSessionId !== writeSessionId) return { ok: false, reason: "session_mismatch" };
  if (project.leaseGeneration !== leaseGeneration)
    return { ok: false, reason: "generation_mismatch" };
  if (!project.writeLeaseExpiresAt || project.writeLeaseExpiresAt <= now) {
    return { ok: false, reason: "lease_expired" };
  }
  return { ok: true };
}

export function planSync({ baseHashes = {}, liveDocuments = [], incoming = [], listOk = false }) {
  if (!listOk || !Array.isArray(incoming) || incoming.length === 0) {
    return { writes: [], deletes: [], conflicts: [], skipped: "empty_or_failed_list" };
  }
  const live = new Map(liveDocuments.map((doc) => [doc.path, doc]));
  const next = new Map(incoming.map((doc) => [doc.path, doc]));
  const writes = [];
  const deletes = [];
  const conflicts = [];

  for (const [path, doc] of next) {
    const current = live.get(path);
    const base = Object.prototype.hasOwnProperty.call(baseHashes, path) ? baseHashes[path] : null;
    if (!current) {
      if (base == null) {
        writes.push({
          op: "insert",
          path,
          content: doc.content,
          contentSha256: doc.contentSha256,
        });
      } else {
        conflicts.push(conflict(path, "missing_live", doc.content, base, null));
      }
      continue;
    }
    if (current.contentSha256 === doc.contentSha256) continue;
    if (base == null || current.contentSha256 !== base) {
      conflicts.push(
        conflict(
          path,
          base == null ? "unexpected_existing" : "base_mismatch",
          doc.content,
          base,
          current.contentSha256
        )
      );
      continue;
    }
    writes.push({
      op: "update",
      path,
      content: doc.content,
      contentSha256: doc.contentSha256,
      expectedSha256: base,
    });
  }

  for (const [path, base] of Object.entries(baseHashes)) {
    if (next.has(path)) continue;
    const current = live.get(path);
    if (!current) continue;
    if (current.contentSha256 !== base) {
      conflicts.push(conflict(path, "delete_base_mismatch", "", base, current.contentSha256));
    } else {
      deletes.push({ path, expectedSha256: base });
    }
  }

  return { writes, deletes, conflicts, skipped: null };
}

export function rejectIncoming({ incoming = [], reason, baseHashes = {} }) {
  return incoming.map((doc) =>
    conflict(
      doc.path,
      reason,
      doc.content,
      Object.prototype.hasOwnProperty.call(baseHashes, doc.path) ? baseHashes[doc.path] : null,
      null
    )
  );
}

function conflict(path, reason, rejectedContent, baseSha256, currentSha256) {
  return { path, reason, rejectedContent, baseSha256, currentSha256 };
}

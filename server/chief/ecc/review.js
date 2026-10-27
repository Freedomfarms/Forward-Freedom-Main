// Evidence review for a finished Cursor coding task.
// WorkforceExecution.verified stays false. This result is computed at read
// time and is not a second task state.
//
// Config protection is re-run against the changed paths at one commit.
// The server checkout is not the file state. Hook execution is recorded
// only when this process observed the script exit.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runAllowlisted } from "./wrapper.js";

export const REQUIRED_CHECK_NAMES = Object.freeze(["verify"]);
export const HOOK_EXECUTION_UNCONFIRMED =
  "Security-hook execution is unconfirmed. Cursor does not return beforeShellExecution results, so block-no-verify was not observed.";

const FILE_CAP = 300;
const KNOWN_STATUSES = new Set(["added", "modified", "removed", "changed", "renamed", "copied"]);

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function checkNameMatches(actual, required) {
  const name = typeof actual === "string" ? actual.trim() : "";
  return name === required || name === `ci / ${required}`;
}

function automatedChecksPassed(evidence, sha) {
  if (!isSha(sha) || evidence.checksHeadSha !== sha) return false;
  const runs = Array.isArray(evidence.checks) ? evidence.checks : [];
  for (const required of REQUIRED_CHECK_NAMES) {
    const matched = runs.filter(
      (run) => checkNameMatches(run?.name, required) && run?.headSha === sha
    );
    if (matched.length !== 1) return false;
    if (matched[0].status !== "completed" || matched[0].conclusion !== "success") return false;
  }
  return true;
}

export function assessVerification(evidence = {}) {
  const failures = [];
  const executionCompleted = evidence.cursorStatus === "FINISHED";
  if (!executionCompleted) failures.push("cursor_not_finished");
  const sha = evidence.headSha;
  if (!isSha(sha)) failures.push("head_sha_missing");
  else if (evidence.checksHeadSha !== sha) failures.push("head_sha_mismatch");

  const runs = Array.isArray(evidence.checks) ? evidence.checks : [];
  if (isSha(sha) && evidence.checksHeadSha === sha) {
    for (const required of REQUIRED_CHECK_NAMES) {
      const matched = runs.filter(
        (run) => checkNameMatches(run?.name, required) && run?.headSha === sha
      );
      if (matched.length !== 1) {
        failures.push(matched.length === 0 ? `check_missing:${required}` : `check_ambiguous:${required}`);
        continue;
      }
      if (matched[0].status !== "completed" || matched[0].conclusion !== "success") {
        failures.push(`check_failed:${required}`);
      }
    }
  }

  const config = evidence.configProtection;
  if (!config || config.ran !== true) failures.push("config_protection_missing");
  else if (!isSha(sha) || config.headSha !== sha) failures.push("config_protection_unbound");
  else if (config.exitCode !== 0) failures.push("config_protection_blocked");

  const shell = evidence.blockNoVerify;
  const hookObserved = shell?.ran === true;
  const hookConfirmed = hookObserved && shell.exitCode === 0;
  if (!hookObserved) failures.push("hook_execution_unconfirmed");
  else if (shell.exitCode !== 0) failures.push("block_no_verify_blocked");

  return {
    executionCompleted,
    verified: failures.length === 0,
    automatedChecksPassed: automatedChecksPassed(evidence, sha),
    hookExecutionConfirmed: hookConfirmed,
    failures,
    headSha: isSha(sha) ? sha : null,
    limitation: hookConfirmed ? null : HOOK_EXECUTION_UNCONFIRMED,
    gates: {
      configProtection: config || { ran: false, exitCode: null, headSha: null },
      blockNoVerify: shell || {
        ran: false,
        exitCode: null,
        reason: "hook_result_not_returned",
      },
    },
    merge: false,
    deploy: false,
  };
}

function contained(root, file) {
  if (typeof file !== "string" || file.includes("\0") || path.isAbsolute(file)) return null;
  if (file.split(/[/\\]/).includes("..")) return null;
  const absolute = path.resolve(root, file);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  if (absolute === root) return null;
  return absolute;
}

function planChange(change) {
  if (!change || typeof change.path !== "string" || change.path.trim() === "") {
    return { ok: false, reason: "paths_missing", file: null };
  }
  if (!KNOWN_STATUSES.has(change.status)) {
    return { ok: false, reason: "change_status_missing", file: change.path };
  }
  if (
    (change.status === "renamed" || change.status === "copied") &&
    (typeof change.previousPath !== "string" || change.previousPath.trim() === "")
  ) {
    return { ok: false, reason: "change_status_missing", file: change.path };
  }
  if (change.status === "added" || change.status === "copied") {
    return { ok: true, targets: [{ path: change.path, exists: false }] };
  }
  if (change.status === "renamed") {
    return {
      ok: true,
      targets: [
        { path: change.previousPath, exists: true },
        { path: change.path, exists: false },
      ],
    };
  }
  return { ok: true, targets: [{ path: change.path, exists: true }] };
}

function gateResult(extra) {
  return {
    ran: false,
    exitCode: null,
    reason: "paths_missing",
    headSha: null,
    file: null,
    source: "commit_diff",
    ...extra,
  };
}

export function reviewCommitChanges(
  changes,
  { headSha, incomplete = false, run = runAllowlisted } = {}
) {
  if (!isSha(headSha)) return gateResult({ reason: "head_sha_missing" });
  if (incomplete) return gateResult({ reason: "diff_incomplete", headSha });
  if (!Array.isArray(changes)) return gateResult({ reason: "paths_missing", headSha });
  if (changes.length >= FILE_CAP) return gateResult({ reason: "diff_incomplete", headSha });

  const root = mkdtempSync(path.join(tmpdir(), "chief-ecc-"));
  try {
    const targets = [];
    for (const change of changes) {
      const planned = planChange(change);
      if (!planned.ok) {
        return gateResult({
          ran: false,
          reason: planned.reason,
          headSha,
          file: planned.file,
        });
      }
      targets.push(...planned.targets);
    }
    for (const target of targets) {
      const absolute = contained(root, target.path);
      if (!absolute) {
        return gateResult({ ran: true, exitCode: 2, reason: "path_rejected", headSha, file: null });
      }
      if (target.exists) {
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, "");
      }
      const result = run({
        script: "config-protection.js",
        stdin: JSON.stringify({ tool_input: { file_path: absolute } }),
      });
      if (!result || result.exitCode !== 0) {
        const observed = result?.ran === true;
        return gateResult({
          ran: observed,
          exitCode: observed ? 2 : null,
          reason: result?.reason || "blocked",
          headSha,
          file: target.path,
        });
      }
    }
    return gateResult({
      ran: true,
      exitCode: 0,
      reason: "allowed",
      headSha,
      file: null,
      files: changes.length,
    });
  } catch {
    return gateResult({ reason: "gate_error", headSha });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function compareTip(body, headSha) {
  if (!isSha(headSha) || !body || typeof body !== "object") return false;
  const commits = Array.isArray(body.commits) ? body.commits : null;
  if (!commits) return false;
  const total = Number.isInteger(body.total_commits) ? body.total_commits : commits.length;
  if (total !== commits.length) return false;
  if (commits.length === 0) {
    return body.ahead_by === 0 && body.base_commit?.sha === headSha;
  }
  return commits[commits.length - 1]?.sha === headSha;
}

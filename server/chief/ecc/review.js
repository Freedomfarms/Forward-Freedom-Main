// Evidence review for a finished Cursor coding task.
// WorkforceExecution.verified stays false. This result is computed at read
// time and is not a second task state.

import path from "node:path";

import { runAllowlisted, REPO_ROOT } from "./wrapper.js";

export const REQUIRED_CHECK_NAMES = Object.freeze(["verify"]);

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function checkNameMatches(actual, required) {
  const name = typeof actual === "string" ? actual.trim() : "";
  return name === required || name === `ci / ${required}`;
}

export function assessVerification(evidence = {}) {
  const failures = [];
  const executionCompleted = evidence.cursorStatus === "FINISHED";
  if (!executionCompleted) failures.push("cursor_not_finished");
  const sha = evidence.headSha;
  if (!isSha(sha)) failures.push("head_sha_missing");
  else if (evidence.checksHeadSha !== sha) failures.push("head_sha_mismatch");

  const runs = Array.isArray(evidence.checks) ? evidence.checks : [];
  if (isSha(sha)) {
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
  else if (config.exitCode !== 0) failures.push("config_protection_blocked");

  const shell = evidence.blockNoVerify;
  if (!shell || shell.ran !== true) failures.push("block_no_verify_missing");
  else if (shell.exitCode !== 0) failures.push("block_no_verify_blocked");

  return {
    executionCompleted,
    verified: failures.length === 0,
    failures,
    headSha: isSha(sha) ? sha : null,
    gates: {
      configProtection: config || { ran: false, exitCode: null },
      blockNoVerify: shell || { ran: false, exitCode: null },
    },
    merge: false,
    deploy: false,
  };
}

function contained(root, file) {
  if (typeof file !== "string" || file.includes("\0") || file.split(/[/\\]/).includes("..")) {
    return null;
  }
  const absolute = path.resolve(root, file);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

export function reviewChangedPaths(files, { root = REPO_ROOT, run = runAllowlisted } = {}) {
  if (!Array.isArray(files)) return { ran: false, exitCode: null, reason: "paths_missing" };
  for (const file of files) {
    const absolute = contained(root, file);
    if (!absolute) return { ran: true, exitCode: 2, reason: "path_rejected", file: null };
    const result = run({
      script: "config-protection.js",
      stdin: JSON.stringify({ tool_input: { file_path: absolute } }),
    });
    if (!result || result.exitCode !== 0) {
      return {
        ran: true,
        exitCode: 2,
        reason: result?.reason || "blocked",
        file,
      };
    }
  }
  return { ran: true, exitCode: 0, reason: "allowed", files: files.length };
}

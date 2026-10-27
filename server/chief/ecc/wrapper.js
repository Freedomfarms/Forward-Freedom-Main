// Freedom OS execution boundary for two unchanged ECC scripts.
// Exit 2 blocks. Any result other than a clean exit 0 is exit 2.
// This module does not spawn a shell and does not accept a script path
// from skill text or from a model.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ALLOWED_HOOK_SCRIPTS } from "./pin.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../../..");
export const HOOK_ROOT = path.join(REPO_ROOT, "third_party", "ecc", "hooks");
const STDIN_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const ALLOWED = new Set(ALLOWED_HOOK_SCRIPTS);

function blocked(reason, extra = {}) {
  return { exitCode: 2, ran: false, reason, stderr: "", ...extra };
}

export function hookScriptPath(name) {
  if (typeof name !== "string" || !ALLOWED.has(name)) return null;
  const resolved = path.resolve(HOOK_ROOT, name);
  if (resolved !== path.join(HOOK_ROOT, name)) return null;
  return resolved;
}

function spawnEnv() {
  const env = { PATH: process.env.PATH || "" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

export function runAllowlisted({
  script,
  stdin = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawnSync,
  cwd = REPO_ROOT,
} = {}) {
  const scriptPath = hookScriptPath(script);
  if (!scriptPath) return blocked("script_not_allowed");
  if (typeof stdin !== "string" || stdin.length > STDIN_LIMIT) return blocked("stdin_rejected");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return blocked("timeout_invalid");
  }
  let result;
  try {
    result = spawnImpl(process.execPath, [scriptPath], {
      cwd,
      input: stdin,
      encoding: "utf8",
      timeout: timeoutMs,
      env: spawnEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return blocked("spawn_failed");
  }
  if (!result || result.error || result.signal || result.status === null || result.status === undefined) {
    return blocked(result?.signal ? "timeout" : "missing_status", {
      signal: result?.signal || null,
    });
  }
  if (result.status !== 0) {
    return {
      exitCode: 2,
      ran: true,
      reason: "blocked",
      script,
      scriptStatus: result.status,
      stderr: typeof result.stderr === "string" ? result.stderr.slice(0, 500) : "",
    };
  }
  return {
    exitCode: 0,
    ran: true,
    reason: "allowed",
    script,
    scriptStatus: 0,
    stderr: typeof result.stderr === "string" ? result.stderr.slice(0, 500) : "",
  };
}

function asObject(raw) {
  if (typeof raw !== "string" || raw.length > STDIN_LIMIT) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function eventKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function pickCommand(parsed) {
  const candidates = [
    parsed.command,
    parsed.args?.command,
    parsed.tool_input?.command,
    parsed.tool_input?.cmd,
    parsed.input?.command,
  ];
  return candidates.find((item) => typeof item === "string" && item.trim() !== "") || "";
}

function pickPaths(parsed) {
  const direct = [
    parsed.file_path,
    parsed.path,
    parsed.file,
    parsed.args?.filePath,
    parsed.tool_input?.file_path,
    parsed.tool_input?.file,
    parsed.tool_input?.path,
    parsed.tool_input?.target_file,
  ].filter((item) => typeof item === "string" && item.trim() !== "");
  const listed = Array.isArray(parsed.file_paths) ? parsed.file_paths : [];
  return [...direct, ...listed.filter((item) => typeof item === "string" && item.trim() !== "")];
}

function toolName(parsed) {
  const name = parsed.tool_name || parsed.tool || "";
  return typeof name === "string" ? name : "";
}

function isShellTool(name) {
  return /shell|bash/i.test(name);
}

function isEditTool(name) {
  return /write|edit|strreplace|search_replace|delete/i.test(name);
}

function combine(results) {
  if (results.some((item) => item.exitCode !== 0)) {
    const failed = results.find((item) => item.exitCode !== 0);
    return { ...failed, exitCode: 2, ran: results.some((item) => item.ran === true) };
  }
  return { exitCode: 0, ran: true, reason: "allowed", scripts: results.map((item) => item.script) };
}

export function runCursorEvent({ event, raw, truncated = false, timeoutMs, spawnImpl } = {}) {
  if (truncated) return blocked("truncated");
  const expected = eventKey(event);
  if (!["beforeshellexecution", "pretooluse", "afterfileedit"].includes(expected)) {
    return blocked("event_unsupported");
  }
  const parsed = asObject(raw);
  if (!parsed) return blocked("payload_unreadable");
  const stated = eventKey(parsed.hook_event_name || parsed.event || "");
  if (stated && stated !== expected) return blocked("event_mismatch");

  const command = pickCommand(parsed);
  const paths = pickPaths(parsed);
  const name = toolName(parsed);
  const run = (script, stdin) => runAllowlisted({ script, stdin, timeoutMs, spawnImpl });

  if (expected === "beforeshellexecution") {
    if (!command) return blocked("command_missing");
    return run("block-no-verify.js", JSON.stringify({ command }));
  }

  if (expected === "afterfileedit") {
    if (paths.length === 0) return blocked("path_missing");
    return combine(
      paths.map((filePath) =>
        run("config-protection.js", JSON.stringify({ tool_input: { file_path: filePath } }))
      )
    );
  }

  // A path on a read is not an edit. Only an edit-like tool, or a payload
  // with no tool name, is sent to config-protection.
  const shellLike = Boolean(command) || isShellTool(name);
  const editLike = isEditTool(name) || (paths.length > 0 && !name && !command);
  const results = [];
  if (shellLike) {
    if (!command) return blocked("command_missing");
    results.push(run("block-no-verify.js", JSON.stringify({ command })));
  }
  if (editLike) {
    if (paths.length === 0) return blocked("path_missing");
    for (const filePath of paths) {
      results.push(
        run("config-protection.js", JSON.stringify({ tool_input: { file_path: filePath } }))
      );
    }
  }
  if (results.length === 0) return { exitCode: 0, ran: false, reason: "not_applicable" };
  return combine(results);
}

export function readHookConfig() {
  return readFileSync(path.join(REPO_ROOT, ".cursor", "hooks.json"), "utf8");
}

// Cursor command hook. The repository hooks.json is the only caller.
// Exit 0 allows the Cursor action. Exit 2 blocks it.

import { runCursorEvent } from "./wrapper.js";

const STDIN_LIMIT = 1024 * 1024;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let truncated = false;
    process.stdin.on("data", (chunk) => {
      if (truncated) return;
      size += chunk.length;
      if (size > STDIN_LIMIT) {
        truncated = true;
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      resolve({ raw: Buffer.concat(chunks).toString("utf8"), truncated });
    });
    process.stdin.on("error", () => {
      resolve({ raw: "", truncated: true });
    });
  });
}

const event = process.argv[2];
const input = await readStdin();
const result = runCursorEvent({
  event,
  raw: input.raw,
  truncated: input.truncated,
});
if (result.stderr) process.stderr.write(`${result.stderr}\n`);
const allowed = result.exitCode === 0;
const permissionEvent = event === "beforeShellExecution" || event === "preToolUse";
const output = permissionEvent
  ? {
      permission: allowed ? "allow" : "deny",
      ...(allowed
        ? {}
        : {
            user_message: "Freedom OS security gate blocked this action.",
            agent_message: "Freedom OS security gate blocked this action.",
          }),
    }
  : {};
process.stdout.write(`${JSON.stringify(output)}\n`);
process.exit(allowed ? 0 : 2);

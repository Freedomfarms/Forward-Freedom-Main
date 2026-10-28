// Guards the per-user memory files against a full replacement the user did
// not ask for. The agent writes the memory store directly, so this cannot
// block the write. It restores afterward. A restore is sent only when the
// live text is still the unsafe write, and only with a content_sha256
// precondition. A concurrent edit, or a 409, is left in place.

const GUARDED = Object.freeze([
  "decisions.md",
  "requirements.md",
  "open-questions.md",
  "next-step.md",
]);

const REPLACE_INTENT = Object.freeze({
  "decisions.md": /\b(decision|decide|decided)\b/i,
  "requirements.md": /\brequirements?\b/i,
  "open-questions.md": /\b(open questions?|questions?)\b/i,
  "next-step.md": /\bnext step\b/i,
});

const BLOCKED_ROOTS = new Set([
  "applications",
  "bin",
  "boot",
  "dev",
  "etc",
  "github",
  "home",
  "lib",
  "lib64",
  "opt",
  "private",
  "proc",
  "root",
  "run",
  "sys",
  "system",
  "tmp",
  "usr",
  "users",
  "var",
  "workspace",
]);

// A provider ask is not permission. Only a path inside the mounted memory
// workspace can be confirmed, and guarded project files are not writable
// through that confirmation.
export function confirmManagedWorkspaceTool(name, input) {
  if (name !== "read" && name !== "write" && name !== "edit" && name !== "glob" && name !== "grep") {
    return "deny";
  }
  const data = input && typeof input === "object" ? input : {};
  const targets = [];
  for (const key of ["path", "file_path", "directory"]) {
    if (typeof data[key] === "string" && data[key].trim()) targets.push(data[key]);
  }
  if ((name === "glob" || name === "grep") && typeof data.pattern === "string" && data.pattern.trim()) {
    targets.push(data.pattern);
  }
  if ((name === "glob" || name === "grep") && typeof data.glob === "string" && data.glob.trim()) {
    targets.push(data.glob);
  }
  if (!targets.length) return name === "write" || name === "edit" ? "deny" : "allow";
  if (targets.some((target) => !workspaceTargetAllowed(target))) return "deny";
  if (name === "write" || name === "edit") {
    const guarded = targets.some((target) => workspaceFileName(target));
    if (guarded) return "deny";
  }
  return "allow";
}

function workspaceTargetAllowed(value) {
  const raw = String(value || "")
    .replace(/\\/g, "/")
    .replaceAll("\u0000", "")
    .trim();
  if (!raw || raw.includes("://") || /[\0\r\n]/.test(raw)) return false;
  if (/^[A-Za-z]:/.test(raw)) return false;
  const parts = raw.split("/");
  if (parts.some((part) => part === "..")) return false;
  const segments = parts.filter((part) => part && part !== ".");
  if (!segments.length) return false;
  if (segments.some((part) => part === ".git" || part === ".ssh" || part.startsWith(".env"))) {
    return false;
  }
  if (segments[0] === "mnt") return segments[1] === "memory" && segments.length > 2;
  if (raw.startsWith("/")) return !BLOCKED_ROOTS.has(segments[0].toLowerCase());
  return true;
}

export function workspaceFileName(value) {
  const path = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const name = path.split("/").pop() || "";
  return GUARDED.includes(name) ? name : "";
}

export function snapshotGuardedMemories(memories) {
  const files = {};
  for (const item of memories || []) {
    const name = workspaceFileName(item?.path);
    if (!name || typeof item.content !== "string" || !item.id) continue;
    files[name] = {
      id: item.id,
      path: item.path,
      content: item.content,
      contentSha256: typeof item.content_sha256 === "string" ? item.content_sha256 : null,
    };
  }
  return files;
}

function eventInput(event) {
  return event?.input && typeof event.input === "object" ? event.input : {};
}

function toolName(event) {
  return event?.name || event?.tool_name || "";
}

function toolUseId(event) {
  return event?.id || event?.tool_use_id || event?.toolUseId || "";
}

function resultFor(events, call, index) {
  const id = toolUseId(call);
  if (id) {
    const paired = events.find(
      (event) =>
        (event?.type === "agent.tool_result" || event?.type === "tool_result") &&
        (event.tool_use_id === id || event.toolUseId === id)
    );
    if (paired) return paired;
  }
  return events.slice(index + 1).find((event) => event?.type === "agent.tool_result" || event?.type === "tool_result");
}

function resultFailed(result) {
  return result?.is_error === true || result?.isError === true;
}

function readSucceeded(events, name, index) {
  for (let cursor = 0; cursor < index; cursor += 1) {
    const event = events[cursor];
    if (event?.type !== "agent.tool_use" && event?.type !== "tool_use") continue;
    if (toolName(event) !== "read") continue;
    if (workspaceFileName(eventInput(event).path || eventInput(event).file_path) !== name) continue;
    const result = resultFor(events, event, cursor);
    if (result && !resultFailed(result)) return true;
  }
  return false;
}

function userAskedToReplace(userText, name) {
  const pattern = REPLACE_INTENT[name];
  return Boolean(pattern && pattern.test(String(userText || "")));
}

function writtenBytes(prior, name, input) {
  if (name === "write" && typeof input.content === "string") return input.content;
  if (name !== "edit") return null;
  if (typeof input.content === "string") return input.content;
  const old = typeof input.old_string === "string" ? input.old_string : null;
  const next = typeof input.new_string === "string" ? input.new_string : null;
  if (old == null || next == null || typeof prior?.content !== "string") return null;
  if (!prior.content.includes(old) || prior.content.split(old).length !== 2) return null;
  return prior.content.replace(old, next);
}

function lastUserTurnStart(events) {
  let start = 0;
  events.forEach((event, index) => {
    if (event?.type === "user.message") start = index + 1;
  });
  return start;
}

// Returns the files that should be put back. A read in the same turn is
// required. A full write must keep the previous text unless the user asked
// to change that file. An edit after a read is kept.
export function planWorkspaceRestore({ snapshot, events, userText } = {}) {
  const files = snapshot && typeof snapshot === "object" ? snapshot : {};
  const list = Array.isArray(events) ? events : [];
  const start = lastUserTurnStart(list);
  const turn = list.slice(start);
  const restores = [];
  const seen = new Set();
  turn.forEach((event, index) => {
    if (event?.type !== "agent.tool_use" && event?.type !== "tool_use") return;
    const name = toolName(event);
    if (name !== "write" && name !== "edit") return;
    const input = eventInput(event);
    const file = workspaceFileName(input.path || input.file_path);
    if (!file || seen.has(file)) return;
    const prior = files[file];
    if (!prior || typeof prior.content !== "string") return;
    const read = readSucceeded(turn, file, index);
    const replacement = typeof input.content === "string" ? input.content : null;
    const keepsPrior = replacement != null && prior.content && replacement.includes(prior.content);
    const asked = userAskedToReplace(userText, file);
    const unsafe = !read || (name === "write" && prior.content && !keepsPrior && !asked);
    if (!unsafe) return;
    seen.add(file);
    restores.push({
      path: file,
      memoryId: prior.id,
      content: prior.content,
      writtenContent: writtenBytes(prior, name, input),
      writeEventId: toolUseId(event) || `${file}:${index}`,
    });
  });
  return restores;
}

export async function captureWorkspaceSnapshot(client, memoryStoreId) {
  if (!client || !memoryStoreId || typeof client.listMemories !== "function") return null;
  try {
    const listed = await client.listMemories(memoryStoreId);
    return snapshotGuardedMemories(listed);
  } catch {
    return null;
  }
}

export async function restoreWorkspaceWrites({ client, memoryStoreId, snapshot, events, userText }) {
  const plan = planWorkspaceRestore({ snapshot, events, userText });
  if (!plan.length || !client || typeof client.listMemories !== "function") return [];
  let listed;
  try {
    listed = (await client.listMemories(memoryStoreId)) || [];
  } catch {
    return [];
  }
  const restored = [];
  for (const item of plan) {
    const current = listed.find((entry) => workspaceFileName(entry?.path) === item.path);
    if (!current?.id || current.content === item.content) {
      restored.push({ path: item.path, writeEventId: item.writeEventId, skipped: true });
      continue;
    }
    if (typeof item.writtenContent !== "string" || current.content !== item.writtenContent) {
      restored.push({ path: item.path, writeEventId: item.writeEventId, preserved: true });
      continue;
    }
    const sha = current.content_sha256;
    if (typeof sha !== "string" || sha.length !== 64) continue;
    try {
      await client.updateMemory(memoryStoreId, current.id, {
        content: item.content,
        precondition: { type: "content_sha256", content_sha256: sha },
      });
      restored.push({ path: item.path, writeEventId: item.writeEventId, skipped: false });
    } catch (error) {
      if (error?.status === 409) {
        restored.push({ path: item.path, writeEventId: item.writeEventId, conflict: true });
        continue;
      }
      throw error;
    }
  }
  return restored;
}

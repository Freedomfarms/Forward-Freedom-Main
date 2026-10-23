const SKILL_FILE = /(?:^|\/)SKILL\.md$/;

export function evaluateSkillRead(events = []) {
  const calls = new Map();
  const results = new Map();
  for (const event of events) {
    if (isReadCall(event)) calls.set(eventId(event), event);
    if (isToolResult(event)) results.set(event.tool_use_id || event.toolUseId, event);
  }
  const passes = [];
  for (const [id, call] of calls) {
    const path = readPath(call);
    if (!path || !SKILL_FILE.test(path)) continue;
    const inline = resultText(call.result ?? call.output ?? call.tool_result);
    const paired = results.get(id);
    const pairedText =
      paired && !paired.is_error
        ? resultText(paired.content ?? paired.result ?? paired.output)
        : "";
    const text = inline || pairedText;
    if (!text) continue;
    if (isDescriptionOnly(call, text)) continue;
    passes.push({ id, path, bytes: text.length });
  }
  return {
    pass: passes.length > 0,
    reads: passes,
    limitation: passes.length
      ? null
      : "No successful read of SKILL.md. A description, preview, or skill id is not a read.",
  };
}

export function inspectWorkspace(files = [], requiredPaths) {
  const byPath = new Map(files.map((file) => [String(file.path || "").replace(/^\/+/, ""), file]));
  const missing = requiredPaths.filter((path) => !String(byPath.get(path)?.content || "").trim());
  return {
    pass: missing.length === 0,
    missing,
    paths: [...byPath.keys()],
  };
}

function isReadCall(event) {
  const type = event?.type;
  const name = event?.name || event?.tool_name;
  return (type === "agent.tool_use" || type === "tool_use") && name === "read";
}

function isToolResult(event) {
  return event?.type === "agent.tool_result" || event?.type === "tool_result";
}

function eventId(event) {
  return event.id || event.event_id || event.tool_use_id;
}

function readPath(event) {
  return event?.input?.path || event?.input?.file_path || event?.path || "";
}

function resultText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result.trim();
  if (Array.isArray(result)) {
    return result
      .map((block) => (typeof block === "string" ? block : block?.text || ""))
      .join("")
      .trim();
  }
  if (typeof result === "object") {
    if (typeof result.text === "string" && result.text.trim()) return result.text.trim();
    if (typeof result.content === "string" && result.content.trim()) return result.content.trim();
    if (Array.isArray(result.content)) return resultText(result.content);
  }
  return "";
}

function isDescriptionOnly(event, text) {
  const description = String(
    event?.description || event?.preview || event?.input?.description || ""
  ).trim();
  if (!description) return false;
  return text === description;
}

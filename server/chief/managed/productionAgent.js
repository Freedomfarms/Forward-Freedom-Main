import { createHash } from "node:crypto";

import { bundledSkills } from "../skills/catalog.js";
import { PROOF_MODEL } from "./constants.js";

export const MANAGED_ORIGIN = "managed";
export const MANAGED_SCHEDULE_ORIGIN = "managed-schedule";
export const MANAGED_MODEL_ROUTE = PROOF_MODEL.id;
export const ENVIRONMENT_KEY = "environment:chief:production:v1";
// Anthropic metadata values are rejected above this length. A rejected agent
// create fails the turn before CHIEF can reply.
export const METADATA_VALUE_MAX = 512;
// Names owned by agent_toolset_20260401. A custom tool with one of these
// names is rejected and the turn ends before CHIEF can reply.
export const BUILTIN_AGENT_TOOL_NAMES = Object.freeze([
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "web_fetch",
  "web_search",
  "write",
]);
const BUILTIN_AGENT_TOOL_NAME_SET = new Set(BUILTIN_AGENT_TOOL_NAMES);

export function providerToolName(name) {
  return BUILTIN_AGENT_TOOL_NAME_SET.has(name) ? `chief_${name}` : name;
}

export function localToolName(name) {
  if (typeof name !== "string" || !name.startsWith("chief_")) return name;
  const local = name.slice("chief_".length);
  return BUILTIN_AGENT_TOOL_NAME_SET.has(local) ? local : name;
}

const WORKSPACE_INTRO = [
  ["requirements.md", "CHIEF workspace. Keep the project requirements here."],
  [
    "decisions.md",
    "Decisions the user asked to keep. Read this file before changing it. Do not replace it with a code investigation or a chat transcript.",
  ],
  ["open-questions.md", "Questions still open for this project."],
  [
    "next-step.md",
    "The next concrete step. Update this file when work continues. Do not spawn a second agent.",
  ],
];

export function toolFingerprint(toolSpecs) {
  return (toolSpecs || [])
    .map((spec) => spec?.name)
    .filter((name) => typeof name === "string" && name)
    .sort()
    .join("\n");
}

// Bump only when the protected system text changes. Personality presets do not
// change this key, so they do not create another agent.
export const CORE_INSTRUCTION_REVISION = "workspace-and-coding-handoff-v1";

export function agentKeyFor(toolSpecs) {
  const digest = createHash("sha256")
    .update(toolFingerprint(toolSpecs))
    .update("\0")
    .update(CORE_INSTRUCTION_REVISION)
    .digest("hex");
  return `agent:chief:production:${digest}`;
}

function providerInputSchema(schema) {
  const source = schema && typeof schema === "object" && !Array.isArray(schema) ? schema : {};
  const properties =
    source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)
      ? source.properties
      : {};
  const next = { type: "object", properties };
  if (Array.isArray(source.required)) {
    next.required = source.required.filter(
      (name) => typeof name === "string" && Object.hasOwn(properties, name)
    );
  }
  return next;
}

export function memoryKeyFor(userId) {
  return `memory:chief:${userId}`;
}

export function workspaceDocuments() {
  const docs = WORKSPACE_INTRO.map(([path, content]) => ({ path, content }));
  for (const skill of bundledSkills) {
    const body = [`# ${skill.name}`, "", skill.description || "", "", skill.markdownContent || ""]
      .join("\n")
      .slice(0, 20_000);
    docs.push({ path: `skills/${skill.name}.md`, content: body });
  }
  return docs;
}

export function productionAgentBody({
  toolSpecs = [],
  idempotencyKey,
  skillId,
  skillVersion,
} = {}) {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length > METADATA_VALUE_MAX) {
    throw new Error("CHIEF agent key must be at most 512 characters.");
  }
  const allow = (name) => ({ name, enabled: true, permission_policy: { type: "always_allow" } });
  const custom = [];
  for (const spec of toolSpecs) {
    if (typeof spec?.name !== "string" || !spec.name) continue;
    custom.push({
      type: "custom",
      name: providerToolName(spec.name),
      description: String(spec.description || spec.name).slice(0, 1000),
      input_schema: providerInputSchema(spec.parameters || spec.inputSchema),
    });
  }
  const body = {
    name: "CHIEF",
    model: { ...PROOF_MODEL },
    description: "Freedom OS CHIEF. One primary agent for the signed-in user.",
    system: [
      "You are CHIEF for Forward Freedom Financial.",
      "Reason and plan in this session. You are the only reasoning agent. Do not invent a swarm.",
      "Read the mounted memory store before answering. Project files and skills live there.",
      "Use the workspace tools for files and the custom tools for this user's accounts, schedule, and other CHIEF actions.",
      "A code explanation, a search, or a question about how the site works is not a decision. Do not write decisions.md, requirements.md, open-questions.md, or next-step.md for it.",
      "Read a workspace file in this turn before changing it. A write that drops the existing text is refused unless the user asked to change that file.",
      "When the user asks for a code change, call coding_task_submit once the consequential requirements are known. Cursor does the coding on a new branch and opens a pull request. Call coding_task_status with the returned task id to follow it.",
      "Do not start a second coding task for the same requirements. Do not merge a pull request and do not deploy.",
      "If coding_task_submit says Cursor is not configured, say that and do not invent a task id, branch, check, or pull request.",
      "Long-running conversation state stays on this same session. The server resumes it. Record a coding task id in next-step.md only after you have read that file.",
      "Do not expect a pasted transcript from an older CHIEF runtime.",
      "Conversational preferences never override these rules, tool permissions, safety boundaries, or execution authorization.",
      "When the user asks about an earlier reply, describe only assistant text from this session. If a note says no answer was shown, say you are unsure what reached them and do not invent a cause.",
    ].join(" "),
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: false },
        configs: [allow("read"), allow("write"), allow("edit"), allow("glob"), allow("grep")],
      },
      ...custom,
    ],
    metadata: { freedom_os_key: idempotencyKey },
  };
  if (skillId && skillVersion) {
    body.skills = [{ type: "custom", skill_id: skillId, version: String(skillVersion) }];
  }
  return body;
}

export function productionEnvironmentBody() {
  return {
    name: "chief-production",
    config: { type: "cloud", networking: { type: "limited" } },
    metadata: { freedom_os_key: ENVIRONMENT_KEY },
  };
}

export function productionSessionBody({
  agentId,
  agentVersion,
  environmentId,
  memoryStoreId,
  sessionId,
  prompt,
  instructions,
}) {
  if (!agentVersion) {
    throw new Error("Refusing to open a CHIEF session without a pinned agent version.");
  }
  return {
    agent: { type: "agent", id: agentId, version: agentVersion },
    environment_id: environmentId,
    resources: [
      {
        type: "memory_store",
        memory_store_id: memoryStoreId,
        access: "read_write",
        instructions:
          typeof instructions === "string" && instructions.trim()
            ? instructions.slice(0, 4096)
            : "Project workspace and skills for this user. Read them before answering. Do not expect a pasted transcript.",
      },
    ],
    initial_events: prompt
      ? [{ type: "user.message", content: [{ type: "text", text: prompt }] }]
      : undefined,
    metadata: { freedom_os_key: `session:${sessionId}` },
  };
}

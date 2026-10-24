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
  ["decisions.md", "Decisions made for this user. Do not paste an old chat transcript."],
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

export function agentKeyFor(toolSpecs) {
  const digest = createHash("sha256").update(toolFingerprint(toolSpecs)).digest("hex");
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
      "Reason and plan in this session. There is one agent; do not invent a swarm.",
      "Read the mounted memory store before answering. Project files and skills live there.",
      "Use the workspace tools for files and the custom tools for this user's accounts, schedule, and other CHIEF actions.",
      "Long-running work stays on this same session. The server resumes it. Update next-step.md instead of delegating to another agent.",
      "Do not expect a pasted transcript from an older CHIEF runtime.",
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
          "Project workspace and skills for this user. Read them before answering. Do not expect a pasted transcript.",
      },
    ],
    initial_events: prompt
      ? [{ type: "user.message", content: [{ type: "text", text: prompt }] }]
      : undefined,
    metadata: { freedom_os_key: `session:${sessionId}` },
  };
}

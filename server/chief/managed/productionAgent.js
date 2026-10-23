import { bundledSkills } from "../skills/catalog.js";
import { PROOF_MODEL } from "./constants.js";

export const MANAGED_ORIGIN = "managed";
export const MANAGED_SCHEDULE_ORIGIN = "managed-schedule";
export const MANAGED_MODEL_ROUTE = PROOF_MODEL.id;
export const ENVIRONMENT_KEY = "environment:chief:production:v1";

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
  return `agent:chief:production:${toolFingerprint(toolSpecs)}`;
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
  const allow = (name) => ({ name, enabled: true, permission_policy: { type: "always_allow" } });
  const custom = [];
  for (const spec of toolSpecs) {
    if (typeof spec?.name !== "string" || !spec.name) continue;
    custom.push({
      type: "custom",
      name: spec.name,
      description: String(spec.description || spec.name).slice(0, 1000),
      input_schema: spec.parameters || spec.inputSchema || { type: "object", properties: {} },
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

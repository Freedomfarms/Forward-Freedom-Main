// First CHIEF tools. Each one is a BaseTool. The turn declares the spec
// without execute; ToolExecutor is the only caller. MCP is remote, so the
// boundary guard blocks it until scanner patterns are ported. No
// code-execution tool is registered.

import { Capability } from "../core/capabilities.js";
import { ToolRegistry } from "../core/registry.js";
import { loadFinanceSummary } from "../../finance/aggregates.js";
import { loadWorkspacePlanSummary } from "../../finance/workspaceSlice.js";
import { TaintLabel } from "../security/taint.js";
import { MemoryFactStore, PrismaFactStore } from "../memory/facts.js";
import { MemoryGraphStore, PrismaGraphStore } from "../memory/graph.js";
import { fencesOutput, scanInjection } from "../security/injection.js";
import { closedPolicy, loadCapabilityPolicy } from "../security/grants.js";
import { PrismaAuditLog } from "../security/audit.js";
import { ToolExecutor } from "./executor.js";
import { CHIEF_TOOL_INVENTORY } from "./inventory.js";
import { HANDOFF_STATE_KEY, validateHandoffNotes } from "../runtime/compaction.js";
import { bundledSkills, skillByName } from "../skills/catalog.js";
import { MemoryScheduleStore, PrismaScheduleStore, normalizeSchedule } from "./schedule-store.js";
import { BaseTool } from "./spec.js";

function memoryRead(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "memory_read",
      description: "Read facts stored for the current user.",
      category: "memory",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.MEMORY_READ],
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
    async execute(params, context) {
      const facts = await store.read({
        userId: context.userId,
        query: params.query ?? "",
        limit: params.limit ?? 20,
      });
      return {
        output: JSON.stringify({
          facts: facts.map((fact) => ({
            id: fact.id,
            content: fact.content,
            trustTier: fact.trustTier,
            source: fact.source,
          })),
        }),
      };
    },
  });
}

function memoryWrite(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "memory_write",
      description: "Store a fact for the current user. Trusted tier cannot be set by the tool.",
      category: "memory",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.MEMORY_WRITE],
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
          trust: { type: "string" },
          source: { type: "string" },
        },
        required: ["content"],
      },
    },
    async execute(params, context) {
      const requested = String(params.trust ?? "auto").toLowerCase();
      if (requested === "trusted") {
        return { output: "trust tier cannot be promoted to trusted by a tool", isError: true };
      }
      let trustTier = requested === "untrusted" ? "UNTRUSTED" : "AUTO";
      const scan = scanInjection(params.content ?? "");
      if (fencesOutput(scan.threatLevel)) {
        return {
          output: "memory write refused: content failed the injection scan",
          isError: true,
        };
      }
      if (!scan.isClean) trustTier = "UNTRUSTED";
      try {
        const stored = await store.write({
          userId: context.userId,
          content: String(params.content ?? ""),
          trustTier,
          source: params.source ?? "tool",
        });
        return { output: JSON.stringify({ id: stored.id, trustTier: stored.trustTier }) };
      } catch (error) {
        return { output: error.message || "memory write failed", isError: true };
      }
    },
  });
}

function kgLookup(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "kg_lookup",
      description: "Look up a knowledge-graph entity and its explicit relations.",
      category: "knowledge",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.MEMORY_READ],
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    async execute(params, context) {
      const found = await store.lookup({ userId: context.userId, name: String(params.name ?? "") });
      return { output: JSON.stringify(found) };
    },
  });
}

function kgLink(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "kg_link",
      description: "Record an explicit relation between two knowledge-graph entities.",
      category: "knowledge",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.MEMORY_WRITE],
      parameters: {
        type: "object",
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          relation: { type: "string" },
        },
        required: ["source", "target", "relation"],
      },
    },
    async execute(params, context) {
      const linked = await store.link({
        userId: context.userId,
        sourceName: String(params.source ?? ""),
        targetName: String(params.target ?? ""),
        relationType: String(params.relation ?? ""),
      });
      return {
        output: JSON.stringify({
          relationId: linked.relation.id,
          origin: linked.relation.origin,
        }),
      };
    },
  });
}

function writeHandoff() {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "write_handoff",
      description:
        "Replace this chat's working checkpoint: goal, constraints, progress, decisions, unresolved work, next steps, and exact history references. Never include private reasoning or credentials.",
      category: "memory",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.MEMORY_WRITE],
      parameters: {
        type: "object",
        properties: { notes: { type: "string" } },
        required: ["notes"],
      },
    },
    async execute(params, context) {
      const notes = String(params.notes ?? "");
      const invalid = validateHandoffNotes(notes);
      if (invalid) return { output: invalid, isError: true };
      if (fencesOutput(scanInjection(notes).threatLevel)) {
        return { output: "handoff notes failed the injection scan", isError: true };
      }
      if (typeof context.saveMiddlewareState !== "function") {
        return { output: "handoff store is not available", isError: true };
      }
      await context.saveMiddlewareState(HANDOFF_STATE_KEY, notes.trim());
      return { output: "Working checkpoint saved." };
    },
  });
}

function scheduleCreate(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "schedule_create",
      description:
        "Schedule a future CHIEF turn. prompt is the instruction the scheduled turn receives; timezone is an IANA zone for cron schedules (default UTC). The task runs later as a schedule-caller turn under the same gates and approvals.",
      category: "schedule",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.SCHEDULE_CREATE],
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string" },
          cronExpr: { type: "string" },
          intervalSeconds: { type: "number" },
          runAt: { type: "string" },
          prompt: { type: "string" },
          timezone: { type: "string" },
          payload: { type: "object" },
        },
        required: ["name", "kind", "prompt"],
      },
    },
    async execute(params, context) {
      let fields;
      try {
        fields = normalizeSchedule(params);
      } catch (error) {
        return { output: error.message, isError: true };
      }
      const task = await store.create({ userId: context.userId, ...fields });
      return {
        output: JSON.stringify({
          id: task.id,
          status: task.status,
          nextRunAt: task.nextRunAt ? new Date(task.nextRunAt).toISOString() : null,
          dispatched: false,
        }),
      };
    },
  });
}

function lifecycleOutput(result) {
  if (result?.error === "not_found") return { output: "scheduled task not found", isError: true };
  if (result?.error === "not_pausable") {
    return { output: "scheduled task cannot be paused", isError: true };
  }
  if (result?.error === "not_resumable") {
    return { output: "scheduled task cannot be resumed", isError: true };
  }
  if (result?.error === "not_cancellable") {
    return { output: "scheduled task cannot be cancelled", isError: true };
  }
  if (result?.error === "invalid_schedule") {
    return { output: result.message || "scheduled task cannot be resumed", isError: true };
  }
  return { output: JSON.stringify(result.task) };
}

function scheduleList(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "schedule_list",
      description:
        "List this user's scheduled tasks: id, name, kind, status, next run, last run, and whether a run is waiting on approval. Does not return run results or operator state.",
      category: "schedule",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.SCHEDULE_CREATE],
      parameters: { type: "object", properties: {} },
    },
    async execute(_params, context) {
      const tasks = await store.list({ userId: context.userId });
      return { output: JSON.stringify({ tasks }) };
    },
  });
}

function schedulePause(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "schedule_pause",
      description:
        "Pause one of this user's active scheduled tasks so later ticks do not claim it. Does not stop a turn that is already running and does not start a new one.",
      category: "schedule",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.SCHEDULE_CREATE],
      parameters: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
      },
    },
    async execute(params, context) {
      const taskId = String(params.taskId ?? "").trim();
      if (!taskId) return { output: "task id is required", isError: true };
      return lifecycleOutput(await store.pause({ userId: context.userId, taskId }));
    },
  });
}

function scheduleResume(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "schedule_resume",
      description:
        "Resume one of this user's paused scheduled tasks and set its next run. Does not run the task.",
      category: "schedule",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.SCHEDULE_CREATE],
      parameters: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
      },
    },
    async execute(params, context) {
      const taskId = String(params.taskId ?? "").trim();
      if (!taskId) return { output: "task id is required", isError: true };
      return lifecycleOutput(await store.resume({ userId: context.userId, taskId }));
    },
  });
}

function scheduleCancel(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "schedule_cancel",
      description:
        "Cancel one of this user's scheduled tasks and clear its next run. The task and its runs are kept. A turn already running is not stopped.",
      category: "schedule",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.SCHEDULE_CREATE],
      parameters: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
      },
    },
    async execute(params, context) {
      const taskId = String(params.taskId ?? "").trim();
      if (!taskId) return { output: "task id is required", isError: true };
      return lifecycleOutput(await store.cancel({ userId: context.userId, taskId }));
    },
  });
}

function updateOutput(result) {
  if (result?.error === "not_found") return { output: "scheduled task not found", isError: true };
  if (result?.error === "not_updatable") {
    return { output: "scheduled task cannot be updated", isError: true };
  }
  if (result?.error === "in_flight") {
    return { output: "scheduled task cannot be updated while a run is in progress", isError: true };
  }
  if (result?.error === "no_updates")
    return { output: "no schedule updates provided", isError: true };
  if (result?.error === "invalid_schedule") {
    return { output: result.message || "scheduled task cannot be updated", isError: true };
  }
  return { output: JSON.stringify(result.task) };
}

function scheduleUpdate(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "schedule_update",
      description:
        "Update one of this user's active or paused scheduled tasks: name, prompt, or schedule. Does not run the task, change its status, or change a task that is locked or waiting on approval.",
      category: "schedule",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.SCHEDULE_CREATE],
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          name: { type: "string" },
          prompt: { type: "string" },
          kind: { type: "string" },
          cronExpr: { type: "string" },
          intervalSeconds: { type: "number" },
          runAt: { type: "string" },
          timezone: { type: "string" },
        },
        required: ["taskId"],
      },
    },
    async execute(params, context) {
      const taskId = String(params?.taskId ?? "").trim();
      if (!taskId) return { output: "task id is required", isError: true };
      return updateOutput(
        await store.update({
          userId: context.userId,
          taskId,
          params,
        })
      );
    },
  });
}

function scheduleRuns(store) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "schedule_runs",
      description:
        "List this user's scheduled runs: id, task, status, attempts, start, and completion. Does not return results, errors, prompts, or session ids. Does not run or change a task.",
      category: "schedule",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.SCHEDULE_CREATE],
      parameters: {
        type: "object",
        properties: { taskId: { type: "string" } },
      },
    },
    async execute(params, context) {
      const taskId = String(params?.taskId ?? "").trim();
      const result = await store.listRuns({ userId: context.userId, taskId: taskId || undefined });
      if (result?.error === "not_found")
        return { output: "scheduled task not found", isError: true };
      return { output: JSON.stringify({ runs: result.runs }) };
    },
  });
}

function financeSummary(load = loadFinanceSummary) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "finance_summary",
      description:
        "Read this user's server-computed spending aggregates, balances grouped by account type, and Plaid connection health. Does not return transactions, merchants, account names, or institution names.",
      category: "finance",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.FINANCE_READ],
      parameters: { type: "object", properties: {} },
    },
    async execute(_params, context) {
      try {
        const summary = await load(context.userId);
        return {
          output: JSON.stringify(summary),
          sessionTaint: [TaintLabel.USER_PRIVATE],
        };
      } catch {
        return {
          output: "finance summary is unavailable",
          isError: true,
          sessionTaint: [TaintLabel.USER_PRIVATE],
        };
      }
    },
  });
}

function workspacePlanSummary(load = loadWorkspacePlanSummary) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "workspace_plan_summary",
      description:
        "Read this user's plan slice: budget and income labels, objective count, plan years, and stored metric fields already saved in the workspace. Does not return the workspace blob or dollar amounts for budget and income rows.",
      category: "finance",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.FINANCE_READ],
      parameters: { type: "object", properties: {} },
    },
    async execute(_params, context) {
      try {
        const summary = await load(context.userId);
        return {
          output: JSON.stringify(summary),
          sessionTaint: [TaintLabel.USER_PRIVATE],
        };
      } catch {
        return {
          output: "workspace plan summary is unavailable",
          isError: true,
          sessionTaint: [TaintLabel.USER_PRIVATE],
        };
      }
    },
  });
}

function skillView(skills = bundledSkills) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "skill_view",
      description:
        "Load one bundled CHIEF procedure by name and return its text. Does not run tools, grant capabilities, or start another turn.",
      category: "skill",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.SKILL_READ],
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name from the skills index.",
          },
        },
        required: ["name"],
      },
    },
    async execute(params) {
      const name = typeof params?.name === "string" ? params.name.trim() : "";
      const skill = skillByName(name, skills);
      if (!skill) {
        const available = skills.map((entry) => entry.name).sort();
        const listed = available.length ? available.join(", ") : "(none)";
        return { output: `Skill '${name}' not found. Available: ${listed}`, isError: true };
      }
      if (fencesOutput(scanInjection(skill.markdownContent).threatLevel)) {
        return { output: `Skill '${name}' failed the injection scan.`, isError: true };
      }
      return { output: skill.markdownContent };
    },
  });
}

function mcpInvoke(client) {
  return new BaseTool({
    isLocal: false,
    spec: {
      name: "mcp_invoke",
      description: "Invoke a tool on a configured MCP server. Outbound calls are boundary-blocked.",
      category: "mcp",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.TOOL_INVOKE],
      parameters: {
        type: "object",
        properties: {
          server: { type: "string" },
          tool: { type: "string" },
          arguments: { type: "object" },
        },
        required: ["tool"],
      },
    },
    async execute(params, context) {
      const transport = context.mcpClient ?? client;
      if (!transport) {
        return { output: "MCP transport is not configured", isError: true };
      }
      const result = await transport.callTool({
        server: params.server ?? null,
        tool: params.tool,
        arguments: params.arguments ?? {},
      });
      return {
        output: typeof result?.output === "string" ? result.output : JSON.stringify(result ?? {}),
        isError: Boolean(result?.isError),
      };
    },
  });
}

export function createChiefTools({
  facts = new MemoryFactStore(),
  graph = new MemoryGraphStore(),
  schedule = new MemoryScheduleStore(),
  mcpClient = null,
  loadFinance = loadFinanceSummary,
  loadWorkspace = loadWorkspacePlanSummary,
  skills = bundledSkills,
} = {}) {
  const tools = [
    memoryRead(facts),
    memoryWrite(facts),
    kgLookup(graph),
    kgLink(graph),
    writeHandoff(),
    scheduleCreate(schedule),
    scheduleList(schedule),
    schedulePause(schedule),
    scheduleResume(schedule),
    scheduleCancel(schedule),
    scheduleUpdate(schedule),
    scheduleRuns(schedule),
    financeSummary(loadFinance),
    workspacePlanSummary(loadWorkspace),
    skillView(skills),
    mcpInvoke(mcpClient),
  ];
  for (const tool of tools) {
    if (!ToolRegistry.contains(tool.spec.name)) {
      ToolRegistry.registerValue(tool.spec.name, tool.spec);
    }
  }
  return tools;
}

export async function createChiefTooling({
  userId,
  stores,
  policy,
  audit = new PrismaAuditLog(),
  bus = null,
  mcpClient = null,
} = {}) {
  let resolved = policy;
  if (!resolved) {
    try {
      resolved = await loadCapabilityPolicy(userId);
    } catch {
      resolved = closedPolicy();
    }
  }
  const tools = createChiefTools({
    facts: stores?.facts ?? new PrismaFactStore(),
    graph: stores?.graph ?? new PrismaGraphStore(),
    schedule: stores?.schedule ?? new PrismaScheduleStore(),
    mcpClient,
  });
  const executor = new ToolExecutor({
    tools,
    policy: resolved,
    audit,
    bus,
    inventory: CHIEF_TOOL_INVENTORY,
  });
  if (!executor.gatesInstalled) {
    throw new Error("refusing to publish CHIEF tools without the gate pipeline");
  }
  return { executor, tools, specs: tools.map((tool) => tool.spec), policy: resolved };
}

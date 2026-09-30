// First CHIEF tools. Each one is a BaseTool. The turn declares the spec
// without execute; ToolExecutor is the only caller. MCP is remote, so the
// boundary guard blocks it until scanner patterns are ported. No
// code-execution tool is registered.

import { Capability } from "../core/capabilities.js";
import { ToolRegistry } from "../core/registry.js";
import { MemoryFactStore, PrismaFactStore } from "../memory/facts.js";
import { MemoryGraphStore, PrismaGraphStore } from "../memory/graph.js";
import { fencesOutput, scanInjection } from "../security/injection.js";
import { closedPolicy, loadCapabilityPolicy } from "../security/grants.js";
import { PrismaAuditLog } from "../security/audit.js";
import { ToolExecutor } from "./executor.js";
import { CHIEF_TOOL_INVENTORY } from "./inventory.js";
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
} = {}) {
  const tools = [
    memoryRead(facts),
    memoryWrite(facts),
    kgLookup(graph),
    kgLink(graph),
    scheduleCreate(schedule),
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
  return { executor, tools, specs: tools.map((tool) => tool.spec) };
}

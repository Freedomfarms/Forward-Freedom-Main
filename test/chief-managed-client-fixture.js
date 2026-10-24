// In-memory Claude Managed Agents client. No network.

function normalize(step) {
  if (!step || typeof step !== "object") return { text: "" };
  if (step.throws) return step;
  if (step.tool || step.running || step.reasoning || typeof step.text === "string") return step;
  const tool = Array.isArray(step.parts)
    ? step.parts.find((part) => part?.type === "tool-call")
    : null;
  if (tool) {
    return {
      tool: { id: tool.toolCallId, name: tool.toolName, input: tool.input ?? {} },
    };
  }
  const text = Array.isArray(step.parts)
    ? step.parts
        .filter((part) => part?.type === "text-delta" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
    : "";
  return { text };
}

function bucketOf(stepsOrBucket) {
  if (Array.isArray(stepsOrBucket)) return { steps: stepsOrBucket, cursor: 0 };
  return stepsOrBucket;
}

export function scriptedManagedClient(stepsOrBucket) {
  const bucket = bucketOf(stepsOrBucket);
  const state = {
    agents: [],
    environments: [],
    stores: [],
    memories: [],
    sessions: new Map(),
    sent: [],
  };

  function take() {
    // The last scripted step repeats, matching the previous scripted model.
    // A single provider error therefore fails every later attempt.
    const index = bucket.steps.length ? Math.min(bucket.cursor, bucket.steps.length - 1) : 0;
    bucket.cursor += 1;
    const step = normalize(bucket.steps[index] ?? { text: "" });
    if (step.throws) throw step.throws;
    return step;
  }

  function apply(session, step) {
    const n = bucket.cursor;
    if (step.reasoning) {
      session.events.push({
        id: `reason-${n}`,
        type: "agent.message",
        content: [{ type: "thinking", text: step.reasoning }],
      });
    }
    if (step.text) {
      session.events.push({
        id: `msg-${n}`,
        type: "agent.message",
        content: [{ type: "text", text: step.text }],
      });
    }
    if (step.tool) {
      session.events.push({
        id: step.tool.id || `tool-${n}`,
        type: "agent.custom_tool_use",
        name: step.tool.name,
        input: step.tool.input ?? {},
      });
      session.status = "running";
      return;
    }
    if (step.running) {
      session.status = "running";
      return;
    }
    session.events.push({ id: `idle-${n}`, type: "session.status_idle" });
    session.status = "idle";
  }

  return {
    state,
    async listAgents() {
      return state.agents;
    },
    async createAgent(body) {
      const row = { id: "agent_1", version: "1", metadata: body.metadata, body };
      state.agents.push(row);
      return row;
    },
    async retrieveAgent(id) {
      return state.agents.find((row) => row.id === id) || null;
    },
    async listEnvironments() {
      return state.environments;
    },
    async createEnvironment(body) {
      const row = { id: "env_1", metadata: body.metadata };
      state.environments.push(row);
      return row;
    },
    async retrieveEnvironment(id) {
      return state.environments.find((row) => row.id === id) || null;
    },
    async listMemoryStores() {
      return state.stores;
    },
    async createMemoryStore(body) {
      const row = {
        id: `mem_${state.stores.length + 1}`,
        metadata: body.metadata,
        name: body.name,
      };
      state.stores.push(row);
      return row;
    },
    async listMemories(storeId) {
      return state.memories.filter((item) => item.storeId === storeId);
    },
    async createMemory(storeId, body) {
      const row = {
        ...body,
        storeId,
        id: `file-${state.memories.length + 1}`,
      };
      state.memories.push(row);
      return { id: row.id };
    },
    async updateMemory(storeId, memoryId, body) {
      const row = state.memories.find((item) => item.id === memoryId && item.storeId === storeId);
      if (!row) {
        const error = new Error("memory not found");
        error.status = 404;
        throw error;
      }
      if (typeof body?.content === "string") row.content = body.content;
      if (typeof body?.path === "string") row.path = body.path;
      return { id: row.id };
    },
    async createSession(body) {
      state.sent.push(body);
      const step = take();
      const session = {
        id: `prov_${state.sessions.size + 1}`,
        status: "running",
        model: { id: "claude-opus-5-5", effort: "medium" },
        resources: body.resources,
        events: [],
      };
      state.sessions.set(session.id, session);
      apply(session, step);
      return session;
    },
    async retrieveSession(id) {
      return state.sessions.get(id);
    },
    async listEvents(id) {
      return state.sessions.get(id)?.events || [];
    },
    async sendEvents(id, events) {
      state.sent.push({ sessionId: id, events });
      const session = state.sessions.get(id);
      const toolResult = (events || []).some((event) => event.type === "user.custom_tool_result");
      const userMessage = (events || []).some((event) => event.type === "user.message");
      if (toolResult || userMessage) apply(session, take());
      return { ok: true };
    },
    async listSkills() {
      return [];
    },
  };
}

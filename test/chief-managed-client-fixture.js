// In-memory Claude Managed Agents client. No network.

export function scriptedManagedClient(steps) {
  let cursor = 0;
  const state = {
    agents: [],
    environments: [],
    stores: [],
    memories: [],
    sessions: new Map(),
    sent: [],
  };

  function apply(session) {
    const step = steps[cursor] ?? { text: "" };
    cursor += 1;
    const n = cursor;
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
    async listMemories() {
      return state.memories;
    },
    async createMemory(_id, body) {
      state.memories.push(body);
      return { id: `file-${state.memories.length}` };
    },
    async createSession(body) {
      state.sent.push(body);
      const session = {
        id: `prov_${state.sessions.size + 1}`,
        status: "running",
        model: { id: "claude-opus-5-5", effort: "medium" },
        resources: body.resources,
        events: [],
      };
      state.sessions.set(session.id, session);
      apply(session);
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
      if (toolResult || userMessage) apply(session);
      return { ok: true };
    },
    async listSkills() {
      return [];
    },
  };
}

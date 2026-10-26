import {
  ANTHROPIC_VERSION,
  ICM_ARCHITECT_PIN,
  MEMORY_BETA,
  PROOF_MODEL,
  SESSION_BETA,
  SESSION_BUDGET_CENTS,
} from "./constants.js";
import { redactSecrets } from "./redact.js";

const DEFAULT_BASE = "https://api.anthropic.com";

export function createAnthropicManagedClient({
  fetchImpl = fetch,
  apiKey,
  baseUrl = DEFAULT_BASE,
} = {}) {
  if (!apiKey) {
    const error = new Error("ANTHROPIC_API_KEY is not configured.");
    error.status = 503;
    throw error;
  }

  function safeProviderMessage(message) {
    let text = String(message || "");
    if (apiKey) text = text.split(apiKey).join("<redacted>");
    return redactSecrets(text);
  }

  async function request(path, { method = "GET", beta, body, form, operation } = {}) {
    const headers = {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (beta) headers["anthropic-beta"] = beta;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: payload });
    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text.slice(0, 300) };
      }
    }
    if (!response.ok) {
      const error = new Error(
        safeProviderMessage(
          parsed?.error?.message || parsed?.message || `Anthropic ${response.status}`
        )
      );
      error.status = response.status;
      error.operation = operation || method;
      throw error;
    }
    return parsed;
  }

  async function listPaged(path, beta, operation) {
    const rows = [];
    let page = null;
    for (let i = 0; i < 10; i += 1) {
      const query = page
        ? `${path}${path.includes("?") ? "&" : "?"}page=${encodeURIComponent(page)}`
        : path;
      const body = await request(query, { beta, operation });
      const batch = body?.data || body?.items || [];
      rows.push(...batch);
      page = body?.next_page || null;
      if (!page || body?.has_more === false) break;
    }
    return rows;
  }

  return {
    beta: { session: SESSION_BETA, memory: MEMORY_BETA },
    listAgents() {
      return listPaged("/v1/agents", SESSION_BETA, "listAgents");
    },
    createAgent(body) {
      return request("/v1/agents", {
        method: "POST",
        beta: SESSION_BETA,
        body,
        operation: "createAgent",
      });
    },
    retrieveAgent(id) {
      return request(`/v1/agents/${encodeURIComponent(id)}`, {
        beta: SESSION_BETA,
        operation: "retrieveAgent",
      });
    },
    updateAgent(id, body) {
      return request(`/v1/agents/${encodeURIComponent(id)}`, {
        method: "POST",
        beta: SESSION_BETA,
        body,
        operation: "updateAgent",
      });
    },
    listSkills() {
      return listPaged("/v1/skills", undefined, "listSkills");
    },
    async createSkill({ filename, zipBytes, displayTitle }) {
      const form = new FormData();
      form.append("display_title", displayTitle);
      form.append("files[]", new Blob([zipBytes]), filename);
      return request("/v1/skills", { method: "POST", form, operation: "createSkill" });
    },
    retrieveSkill(id) {
      return request(`/v1/skills/${encodeURIComponent(id)}`, { operation: "retrieveSkill" });
    },
    listEnvironments() {
      return listPaged("/v1/environments", SESSION_BETA, "listEnvironments");
    },
    createEnvironment(body) {
      return request("/v1/environments", {
        method: "POST",
        beta: SESSION_BETA,
        body,
        operation: "createEnvironment",
      });
    },
    retrieveEnvironment(id) {
      return request(`/v1/environments/${encodeURIComponent(id)}`, {
        beta: SESSION_BETA,
        operation: "retrieveEnvironment",
      });
    },
    listMemoryStores() {
      return listPaged("/v1/memory_stores", MEMORY_BETA, "listMemoryStores");
    },
    createMemoryStore(body) {
      return request("/v1/memory_stores", {
        method: "POST",
        beta: MEMORY_BETA,
        body,
        operation: "createMemoryStore",
      });
    },
    listMemories(storeId) {
      return listPaged(
        `/v1/memory_stores/${encodeURIComponent(storeId)}/memories?view=full`,
        MEMORY_BETA,
        "listMemories"
      );
    },
    listMemoryVersions(storeId, memoryId) {
      const query = new URLSearchParams({ view: "full", limit: "20" });
      if (memoryId) query.set("memory_id", memoryId);
      return listPaged(
        `/v1/memory_stores/${encodeURIComponent(storeId)}/memory_versions?${query.toString()}`,
        MEMORY_BETA,
        "listMemoryVersions"
      );
    },
    createMemory(storeId, body) {
      return request(`/v1/memory_stores/${encodeURIComponent(storeId)}/memories`, {
        method: "POST",
        beta: MEMORY_BETA,
        body,
        operation: "createMemory",
      });
    },
    updateMemory(storeId, memoryId, body) {
      return request(
        `/v1/memory_stores/${encodeURIComponent(storeId)}/memories/${encodeURIComponent(memoryId)}`,
        {
          method: "POST",
          beta: MEMORY_BETA,
          body,
          operation: "updateMemory",
        }
      );
    },
    listSessions() {
      return listPaged("/v1/sessions", SESSION_BETA, "listSessions");
    },
    createSession(body) {
      return request("/v1/sessions", {
        method: "POST",
        beta: SESSION_BETA,
        body,
        operation: "createSession",
      });
    },
    retrieveSession(id) {
      return request(`/v1/sessions/${encodeURIComponent(id)}`, {
        beta: SESSION_BETA,
        operation: "retrieveSession",
      });
    },
    listEvents(sessionId) {
      return listPaged(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
        SESSION_BETA,
        "listEvents"
      );
    },
    sendEvents(sessionId, events) {
      return request(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: "POST",
        beta: SESSION_BETA,
        body: { events },
        operation: "sendEvents",
      });
    },
  };
}

export function proofAgentBody({ skillId, skillVersion, idempotencyKey }) {
  if (!skillId || !skillVersion) {
    throw new Error("Refusing to attach a skill without a stored version id.");
  }
  const allow = (name) => ({ name, enabled: true, permission_policy: { type: "always_allow" } });
  return {
    name: `CHIEF proof ${ICM_ARCHITECT_PIN.slice(0, 12)}`,
    model: { ...PROOF_MODEL },
    description: "Freedom OS CHIEF proof agent. One agent, no multiagent block.",
    system:
      "You are CHIEF for one farm project. Read the memory mount before answering. Do not expect a pasted transcript. Postgres is not yours to write.",
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: false },
        configs: [allow("read"), allow("write"), allow("edit"), allow("glob"), allow("grep")],
      },
      {
        type: "custom",
        name: "proof_ping",
        description: "Record one server-side proof ping after the project files are saved.",
        input_schema: {
          type: "object",
          properties: { note: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
    skills: [{ type: "custom", skill_id: skillId, version: String(skillVersion) }],
    metadata: { freedom_os_key: idempotencyKey },
  };
}

export function proofEnvironmentBody(idempotencyKey) {
  return {
    name: "freedom-os-chief-cloud-limited",
    config: { type: "cloud", networking: { type: "limited" } },
    metadata: { freedom_os_key: idempotencyKey },
  };
}

export function proofSessionBody({
  agentId,
  agentVersion,
  environmentId,
  storeId,
  access,
  prompt,
  runId,
}) {
  if (!agentVersion) {
    throw new Error("Refusing to open a session without a pinned agent version.");
  }
  return {
    agent: { type: "agent", id: agentId, version: agentVersion },
    environment_id: environmentId,
    resources: [
      {
        type: "memory_store",
        memory_store_id: storeId,
        access,
        instructions: "Project files for this proof. Read them before answering.",
      },
    ],
    initial_events: prompt
      ? [{ type: "user.message", content: [{ type: "text", text: prompt }] }]
      : undefined,
    budget: { type: "limit", max_list_cost: { amount: SESSION_BUDGET_CENTS, currency: "USD" } },
    metadata: { freedom_os_key: `session:${runId}` },
  };
}

export function recordModelEvidence(session) {
  const configured = session?.model ?? session?.agent?.model ?? null;
  const served = session?.served_model ?? session?.servedModel ?? null;
  const requested = { ...PROOF_MODEL };
  const servedId = served && typeof served === "object" ? served.id : served;
  return {
    requested,
    configured,
    servedModel: served,
    independentServingProof: Boolean(servedId) && servedId === requested.id,
    limitation: served
      ? null
      : "No served-model field distinct from the configured model was returned. The configured model is echoed configuration, not independent serving proof.",
  };
}

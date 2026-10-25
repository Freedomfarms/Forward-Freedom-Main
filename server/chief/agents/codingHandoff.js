// CHIEF review handoff. coding_task_submit calls this client, not
// createExecutionRuntime. That executor keeps autoCreatePR false and cannot
// open a pull request. This client sends autoCreatePR true, workOnCurrentBranch
// false, and never calls merge or deploy.
// One requirements text maps to one Cursor agent while that run is unfinished.
// The id is derived from the user, the text, and an attempt number, so a
// restarted process finds the same agent. A new attempt is created only when
// the caller asks and the previous run has finished or failed.

import { createHash } from "node:crypto";

import { containsObviousSecret } from "../codeintel/policy.js";
import { isExactRepositoryUrl, isProtectedRepository, isTerminalStatus } from "./execution.js";

const BASE_URL = "https://api.cursor.com";
const GITHUB_API = "https://api.github.com";
const AGENT_ID = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ATTEMPT = 20;
const API_KEY = /^[^\s]{8,512}$/;

export function normalizeRequirements(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

export function repositoryUrlFor(env = process.env) {
  const configured =
    typeof env?.CHIEF_CODE_REPOSITORY === "string" && env.CHIEF_CODE_REPOSITORY.trim()
      ? env.CHIEF_CODE_REPOSITORY.trim()
      : "Freedomfarms/Forward-Freedom-Main";
  const url = configured.startsWith("https://")
    ? configured
    : `https://github.com/${configured.replace(/^\/+|\/+$/g, "")}`;
  return url.replace(/\.git$/, "").replace(/\/$/, "");
}

export function allowlistFor(env = process.env) {
  const raw = env?.CHIEF_CURSOR_REPOSITORY_ALLOWLIST;
  if (typeof raw === "string" && raw.trim()) {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [repositoryUrlFor(env)];
}

export function taskAgentId(userId, requirements, attempt = 0) {
  const digest = createHash("sha256")
    .update(String(userId || ""))
    .update("\0")
    .update(normalizeRequirements(requirements))
    .update("\0")
    .update(String(attempt))
    .digest("hex");
  const chars = digest.slice(0, 32).split("");
  chars[12] = "4";
  const variant = Number.parseInt(chars[16], 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function codingTaskPrompt(requirements) {
  return [
    normalizeRequirements(requirements),
    "",
    "Open a pull request on a new branch and mark it ready for review.",
    "Do not merge. Do not deploy. Do not push to the default branch.",
    "The pull request description must include what changed, why, the validation you ran and its results, and any unresolved limitations.",
  ].join("\n");
}

function cursorKey(env) {
  const value = typeof env?.CURSOR_API_KEY === "string" ? env.CURSOR_API_KEY.trim() : "";
  return API_KEY.test(value) ? value : "";
}

function githubToken(env) {
  const value = typeof env?.CHIEF_CODE_READ_TOKEN === "string" ? env.CHIEF_CODE_READ_TOKEN.trim() : "";
  return value.length >= 8 ? value : "";
}

function parseRepository(url) {
  try {
    const parsed = new URL(url);
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;
    return { owner, repo: repo.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

function platformGit(run) {
  const branches = [];
  const pullRequests = [];
  const list = run?.git?.branches;
  if (!Array.isArray(list)) return { branches, pullRequests };
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const branch = typeof entry.branch === "string" ? entry.branch.trim() : "";
    const prUrl = typeof entry.prUrl === "string" ? entry.prUrl.trim() : "";
    if (branch) branches.push(branch);
    if (prUrl) pullRequests.push(prUrl);
  }
  return { branches, pullRequests };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createCodingHandoff({
  env = process.env,
  fetchImpl = globalThis.fetch,
  memoryClient = null,
  memoryStoreId = null,
} = {}) {
  const repositoryUrl = repositoryUrlFor(env);
  const allowlist = allowlistFor(env);
  const key = cursorKey(env);
  const token = githubToken(env);

  async function cursor(path, { method = "GET", body } = {}) {
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { response, body: await readJson(response) };
  }

  async function remember(record) {
    if (!memoryClient || !memoryStoreId || typeof memoryClient.listMemories !== "function") return;
    try {
      const listed = (await memoryClient.listMemories(memoryStoreId)) || [];
      const current = listed.find((item) => String(item.path || "").endsWith("coding-tasks.json"));
      let tasks = [];
      try {
        tasks = JSON.parse(current?.content || "{}").tasks || [];
      } catch {
        tasks = [];
      }
      if (!Array.isArray(tasks)) tasks = [];
      const index = tasks.findIndex((item) => item?.taskId === record.taskId);
      const next = { ...record, updatedAt: new Date().toISOString() };
      if (index >= 0) tasks[index] = { ...tasks[index], ...next };
      else tasks.push(next);
      const content = JSON.stringify({ tasks: tasks.slice(-20) });
      if (current?.id && typeof memoryClient.updateMemory === "function") {
        await memoryClient.updateMemory(memoryStoreId, current.id, {
          content,
          ...(current.content_sha256
            ? { precondition: { type: "content_sha256", content_sha256: current.content_sha256 } }
            : {}),
        });
        return;
      }
      if (typeof memoryClient.createMemory === "function") {
        await memoryClient.createMemory(memoryStoreId, { path: "/coding-tasks.json", content });
      }
    } catch {
      // The Cursor agent id still prevents a second job.
    }
  }

  function view(run, { taskId, duplicate = false, requirements, attempt = 0 }) {
    const git = platformGit(run);
    const status = typeof run?.status === "string" ? run.status : "UNKNOWN";
    const pullRequestUrl = git.pullRequests[0] || null;
    const limitations = [];
    if (isTerminalStatus(status) && !pullRequestUrl) {
      limitations.push("Cursor finished without a pull request URL.");
    }
    if (!token) {
      limitations.push("CHIEF_CODE_READ_TOKEN is not configured, so the diff and checks were not read.");
    }
    return {
      available: true,
      provider: "cursor-cloud",
      taskId,
      agentId: run?.agentId || taskId,
      runId: run?.id || run?.runId || null,
      status,
      terminal: isTerminalStatus(status),
      duplicate,
      attempt: Number.isInteger(attempt) ? attempt : null,
      repositoryUrl,
      branch: git.branches[0] || null,
      pullRequestUrl,
      requirements: requirements || null,
      statement: typeof run?.result === "string" ? run.result.slice(0, 2000) : null,
      merged: false,
      deployed: false,
      limitations,
    };
  }

  async function lookup(taskId) {
    const { response, body } = await cursor(`/v1/agents/${encodeURIComponent(taskId)}`);
    if (response.status === 404) return { found: false };
    if (!response.ok) {
      return {
        found: false,
        error: response.status === 401 || response.status === 403 ? "authentication_failed" : "request_rejected",
      };
    }
    return { found: body?.id === taskId, agent: body };
  }

  async function readRun(agentId, runId) {
    if (!runId) return null;
    const { response, body } = await cursor(
      `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`
    );
    if (!response.ok || body?.id !== runId) return null;
    return body;
  }

  async function github(pathname) {
    if (!token) return { available: false, missing: "CHIEF_CODE_READ_TOKEN" };
    const repo = parseRepository(repositoryUrl);
    if (!repo) return { available: false, missing: "repository" };
    if (!pathname.startsWith(`/repos/${repo.owner}/${repo.repo}/`)) {
      return { available: false, missing: "repository" };
    }
    let response;
    try {
      response = await fetchImpl(`${GITHUB_API}${pathname}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "Freedom-OS-CHIEF",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      return { available: false, missing: "network" };
    }
    if (response.status === 401 || response.status === 403) {
      return { available: false, missing: "checks_permission" };
    }
    if (!response.ok) return { available: false, missing: "request_rejected" };
    const body = await readJson(response);
    return { available: true, body };
  }

  async function review(branch) {
    if (!branch || branch.includes("..") || branch.includes(" ") || !token) {
      return {
        diff: { available: false, missing: token ? "branch" : "CHIEF_CODE_READ_TOKEN" },
        checks: { available: false, missing: token ? "branch" : "CHIEF_CODE_READ_TOKEN" },
      };
    }
    const repo = parseRepository(repositoryUrl);
    if (!repo) {
      return {
        diff: { available: false, missing: "repository" },
        checks: { available: false, missing: "repository" },
      };
    }
    const base = "main";
    const compare = await github(
      `/repos/${repo.owner}/${repo.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`
    );
    const checks = await github(
      `/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=20`
    );
    let diff = { available: false, missing: compare.missing || "request_rejected" };
    if (compare.available) {
      const files = Array.isArray(compare.body?.files) ? compare.body.files : [];
      let excerpt = "";
      const listed = files.slice(0, 40).map((file) => {
        const patch = typeof file?.patch === "string" ? file.patch : "";
        if (excerpt.length < 4000 && patch && !containsObviousSecret(patch, token)) {
          excerpt += `${file.filename}\n${patch.slice(0, 800)}\n`;
        }
        return {
          filename: file?.filename || "",
          status: file?.status || "",
          additions: file?.additions ?? null,
          deletions: file?.deletions ?? null,
        };
      });
      diff = {
        available: true,
        aheadBy: compare.body?.ahead_by ?? null,
        behindBy: compare.body?.behind_by ?? null,
        truncated: files.length > listed.length || excerpt.length >= 4000,
        files: listed,
        excerpt: excerpt.slice(0, 4000),
      };
    }
    let checkView = { available: false, missing: checks.missing || "request_rejected" };
    if (checks.available) {
      const runs = Array.isArray(checks.body?.check_runs) ? checks.body.check_runs : [];
      checkView = {
        available: true,
        total: checks.body?.total_count ?? runs.length,
        runs: runs.slice(0, 20).map((run) => ({
          name: run?.name || "",
          status: run?.status || "",
          conclusion: run?.conclusion || null,
        })),
      };
    }
    return { diff, checks: checkView };
  }

  async function inspect(userId, text, attempt) {
    const taskId = taskAgentId(userId, text, attempt);
    if (!AGENT_ID.test(taskId)) return { error: "task_id_invalid", taskId, attempt };
    const existing = await lookup(taskId);
    if (existing.error) return { error: existing.error, taskId, attempt };
    if (!existing.found) return { found: false, taskId, attempt };
    const run = await readRun(taskId, existing.agent?.latestRunId);
    return { found: true, taskId, attempt, agent: existing.agent, run };
  }

  async function latestAttempt(userId, text) {
    let latest = null;
    for (let attempt = 0; attempt <= MAX_ATTEMPT; attempt += 1) {
      const inspected = await inspect(userId, text, attempt);
      if (inspected.error) return inspected;
      if (!inspected.found) return latest || inspected;
      latest = inspected;
      if (!isTerminalStatus(inspected.run?.status)) return latest;
    }
    return latest;
  }

  function seen(inspected, { duplicate, requirements, text }) {
    const run = inspected.run || {
      agentId: inspected.taskId,
      id: inspected.agent?.latestRunId,
      status: "UNKNOWN",
    };
    return view(run, {
      taskId: inspected.taskId,
      duplicate,
      requirements: requirements || text,
      attempt: inspected.attempt,
    });
  }

  async function create(userId, text, attempt) {
    const taskId = taskAgentId(userId, text, attempt);
    if (!AGENT_ID.test(taskId)) return { available: false, error: "task_id_invalid" };
    const created = await cursor("/v1/agents", {
      method: "POST",
      body: {
        prompt: { text: codingTaskPrompt(text) },
        repos: [{ url: repositoryUrl, startingRef: "main" }],
        workOnCurrentBranch: false,
        autoCreatePR: true,
        agentId: taskId,
      },
    });
    if (created.response.status === 409) {
      const again = await inspect(userId, text, attempt);
      const result = seen(
        again.found ? again : { taskId, attempt, run: { agentId: taskId, status: "UNKNOWN" } },
        { duplicate: true, text }
      );
      await remember(result);
      return result;
    }
    if (!created.response.ok) {
      return {
        available: false,
        error:
          created.response.status === 401 || created.response.status === 403
            ? "authentication_failed"
            : "request_rejected",
        taskId,
        attempt,
      };
    }
    const agentId = created.body?.agent?.id;
    const runId = created.body?.run?.id;
    const status = created.body?.run?.status;
    if (agentId !== taskId || typeof runId !== "string" || typeof status !== "string") {
      return { available: false, error: "response_invalid", taskId, attempt };
    }
    const result = view(
      { ...created.body.run, agentId, result: created.body.run?.result },
      { taskId, duplicate: false, requirements: text, attempt }
    );
    await remember(result);
    return result;
  }

  return {
    repositoryUrl,
    async submit({ userId, requirements, newAttempt = false } = {}) {
      const text = normalizeRequirements(requirements);
      if (!userId || !text || text.length > 8000) {
        return { available: false, error: "requirements_invalid" };
      }
      if (!isExactRepositoryUrl(repositoryUrl) || isProtectedRepository(repositoryUrl)) {
        return { available: false, error: "repository_not_allowed" };
      }
      if (!allowlist.includes(repositoryUrl)) {
        return { available: false, error: "repository_not_allowed" };
      }
      if (!key) {
        return {
          available: false,
          missing: "CURSOR_API_KEY",
          error: "Cursor coding handoff is not configured. Set CURSOR_API_KEY on the server.",
          merged: false,
          deployed: false,
        };
      }
      if (text.includes(key) || (token && text.includes(token))) {
        return { available: false, error: "requirements_invalid" };
      }
      const latest = await latestAttempt(userId, text);
      if (latest?.error) return { available: false, error: latest.error, taskId: latest.taskId };
      if (latest?.found) {
        const terminal = isTerminalStatus(latest.run?.status);
        if (!newAttempt || !terminal) {
          const result = seen(latest, { duplicate: true, text });
          if (newAttempt && !terminal) {
            result.limitations.push(
              "The earlier task is still running, so a new attempt was not started."
            );
          }
          await remember(result);
          return result;
        }
        if (latest.attempt >= MAX_ATTEMPT) {
          return { available: false, error: "attempt_limit", taskId: latest.taskId };
        }
        return create(userId, text, latest.attempt + 1);
      }
      return create(userId, text, latest?.attempt || 0);
    },

    async status({ userId, taskId, requirements } = {}) {
      const text = normalizeRequirements(requirements);
      if (!key) {
        const id = AGENT_ID.test(taskId || "") ? taskId : "";
        return {
          available: false,
          missing: "CURSOR_API_KEY",
          error: "Cursor coding handoff is not configured. Set CURSOR_API_KEY on the server.",
          taskId: id,
        };
      }
      let inspected;
      if (AGENT_ID.test(taskId || "")) {
        const existing = await lookup(taskId);
        if (existing.error) return { available: false, error: existing.error, taskId };
        if (!existing.found) return { available: false, error: "task_not_found", taskId };
        const run = await readRun(taskId, existing.agent?.latestRunId);
        inspected = { found: true, taskId, attempt: null, agent: existing.agent, run };
      } else if (text && userId) {
        inspected = await latestAttempt(userId, text);
        if (inspected?.error) return { available: false, error: inspected.error, taskId: inspected.taskId };
        if (!inspected?.found) return { available: false, error: "task_not_found", taskId: inspected?.taskId };
      } else {
        return { available: false, error: "task_id_invalid" };
      }
      const result = seen(inspected, { duplicate: false, requirements: text });
      const reviewed = await review(result.branch);
      result.diff = reviewed.diff;
      result.checks = reviewed.checks;
      if (reviewed.checks?.available) {
        const failing = (reviewed.checks.runs || []).filter(
          (item) =>
            item.conclusion &&
            item.conclusion !== "success" &&
            item.conclusion !== "skipped" &&
            item.conclusion !== "neutral"
        );
        if (failing.length) result.limitations.push("One or more checks did not succeed.");
      }
      await remember(result);
      return result;
    },
  };
}

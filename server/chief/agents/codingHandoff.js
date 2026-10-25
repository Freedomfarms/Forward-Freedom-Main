// CHIEF delegates coding to one Cursor cloud agent and stops at an open pull
// request. This process does not merge, deploy, or write the repository.
// The same requirements reuse one Cursor agent id so a retry does not start
// a second coding job.

import { createHash } from "node:crypto";

import { containsObviousSecret } from "../codeintel/policy.js";
import { isExactRepositoryUrl, isProtectedRepository, isTerminalStatus } from "./execution.js";

const BASE_URL = "https://api.cursor.com";
const GITHUB_API = "https://api.github.com";
const AGENT_ID = /^bc-[a-f0-9]{32}$/;
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

export function taskAgentId(userId, requirements) {
  const digest = createHash("sha256")
    .update(String(userId || ""))
    .update("\0")
    .update(normalizeRequirements(requirements))
    .digest("hex")
    .slice(0, 32);
  return `bc-${digest}`;
}

export function codingTaskPrompt(requirements) {
  return [
    normalizeRequirements(requirements),
    "",
    "Open a pull request on a new branch.",
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

  function view(run, { taskId, duplicate = false, requirements }) {
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

  return {
    repositoryUrl,
    async submit({ userId, requirements } = {}) {
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
      const taskId = taskAgentId(userId, text);
      if (!AGENT_ID.test(taskId)) return { available: false, error: "task_id_invalid" };
      const existing = await lookup(taskId);
      if (existing.error) return { available: false, error: existing.error, taskId };
      if (existing.found) {
        const run = await readRun(taskId, existing.agent?.latestRunId);
        const result = view(run || { agentId: taskId, id: existing.agent?.latestRunId, status: "UNKNOWN" }, {
          taskId,
          duplicate: true,
          requirements: text,
        });
        await remember(result);
        return result;
      }
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
        const again = await lookup(taskId);
        const run = again.found ? await readRun(taskId, again.agent?.latestRunId) : null;
        const result = view(run || { agentId: taskId, status: "UNKNOWN" }, {
          taskId,
          duplicate: true,
          requirements: text,
        });
        await remember(result);
        return result;
      }
      if (!created.response.ok) {
        return {
          available: false,
          error: created.response.status === 401 || created.response.status === 403
            ? "authentication_failed"
            : "request_rejected",
          taskId,
        };
      }
      const agentId = created.body?.agent?.id;
      const runId = created.body?.run?.id;
      const status = created.body?.run?.status;
      if (agentId !== taskId || typeof runId !== "string" || typeof status !== "string") {
        return { available: false, error: "response_invalid", taskId };
      }
      const result = view(
        { ...created.body.run, agentId, result: created.body.run?.result },
        { taskId, duplicate: false, requirements: text }
      );
      await remember(result);
      return result;
    },

    async status({ userId, taskId, requirements } = {}) {
      const text = normalizeRequirements(requirements);
      const id = AGENT_ID.test(taskId || "") ? taskId : text && userId ? taskAgentId(userId, text) : "";
      if (!AGENT_ID.test(id)) return { available: false, error: "task_id_invalid" };
      if (!key) {
        return {
          available: false,
          missing: "CURSOR_API_KEY",
          error: "Cursor coding handoff is not configured. Set CURSOR_API_KEY on the server.",
          taskId: id,
        };
      }
      const existing = await lookup(id);
      if (existing.error) return { available: false, error: existing.error, taskId: id };
      if (!existing.found) return { available: false, error: "task_not_found", taskId: id };
      const run = await readRun(id, existing.agent?.latestRunId);
      const result = view(run || { agentId: id, id: existing.agent?.latestRunId, status: "UNKNOWN" }, {
        taskId: id,
        duplicate: false,
      });
      const branch = result.branch;
      const reviewed = await review(branch);
      result.diff = reviewed.diff;
      result.checks = reviewed.checks;
      if (reviewed.checks?.available) {
        const failing = (reviewed.checks.runs || []).filter(
          (item) => item.conclusion && item.conclusion !== "success" && item.conclusion !== "skipped" && item.conclusion !== "neutral"
        );
        if (failing.length) result.limitations.push("One or more checks did not succeed.");
      }
      await remember(result);
      return result;
    },
  };
}

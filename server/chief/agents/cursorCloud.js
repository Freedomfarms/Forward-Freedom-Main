// Cursor Cloud Agents API v1 execution provider.
//
// One approved scope becomes one create call: POST /v1/agents. The body
// may carry a client-supplied bc- agentId. Cursor treats a repeat of that
// id as 409 agent_id_conflict rather than a second agent. This module
// records that conflict as ambiguous and does not POST again.
// autoCreatePR stays false unless the approval scope is the coding scope:
// effect execute, workOnCurrentBranch false, autoCreatePR true, merge false,
// deploy false, startingRef main. No other create body may set it true.
// Status is read with GET /v1/agents/{id}/runs/{runId}. Cancel is POST on
// that run. GET /v1/agents/{id} returning 404 does not prove the create
// never landed. This module does not poll, stream, or call the API while
// it is constructed. The turn loop does not import it.

import {
  EXECUTION_EFFECTS,
  ExecutionError,
  isExactRepositoryUrl,
  isProtectedRepository,
  isRunStatus,
  isTerminalStatus,
} from "./execution.js";
import { isCodingExecutionScope, isLegacyExecutionScope } from "./ledger.js";

const PROVIDER = "cursor-cloud";
const BASE_URL = "https://api.cursor.com";
const AGENT_ID = /^bc-[A-Za-z0-9-]{8,200}$/;
const RUN_ID = /^run-[A-Za-z0-9-]{8,200}$/;
const APPROVAL_ID = /^[A-Za-z0-9_-]{8,200}$/;
const API_KEY = /^[^\s]{8,512}$/;
const CODING_MODEL_ID = "grok-4.7";
const CODING_MODEL_NAME = "Grok 4.7";

// The id sent to Create An Agent must be one returned by GET /v1/models.
// Prefer the canonical grok-4.7 id. A single item whose display name is
// exactly "Grok 4.7" may use that item's id. Effort variants and other
// models are not substitutes.
export function selectCursorCodingModel(items) {
  if (!Array.isArray(items)) return null;
  const models = items.filter(
    (item) => item && typeof item.id === "string" && item.id.trim() !== "" && item.id === item.id.trim()
  );
  const exact = models.find((item) => item.id === CODING_MODEL_ID);
  if (exact) return exact.id;
  const named = models.filter((item) => item.displayName === CODING_MODEL_NAME);
  if (named.length === 1) return named[0].id;
  return null;
}

function fail(code, message) {
  throw new ExecutionError(code, message);
}

function normalizeAllowlist(value) {
  if (value == null) return null;
  if (!Array.isArray(value))
    fail("allowlist_missing", "Cursor execution repository allowlist is not configured");
  const allowed = [];
  for (const entry of value) {
    if (typeof entry === "string" && isProtectedRepository(entry)) {
      fail(
        "repository_forbidden",
        "Freedom Financial and XRP repositories cannot be execution targets"
      );
    }
    if (!isExactRepositoryUrl(entry)) {
      fail(
        "allowlist_invalid",
        "Cursor execution allowlist entries must be exact https repository URLs"
      );
    }
    if (!allowed.includes(entry)) allowed.push(entry);
  }
  return allowed;
}

function resolveTimeout(value) {
  if (value == null) return 30_000;
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    fail("configuration_invalid", "Cursor execution timeout is invalid");
  }
  return value;
}

function hasControlChar(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function userIdOf(value) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 200 &&
    !hasControlChar(value)
  );
}

function objectiveOf(value) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 8000 &&
    !value.includes("\u0000")
  );
}

function refOf(value) {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 255 &&
    !hasControlChar(value) &&
    !/\s/.test(value) &&
    !value.includes("..") &&
    !value.startsWith("/") &&
    !value.endsWith("/")
  );
}

function approvalCurrent(approval, now) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return false;
  if (approval.decision !== "approved" || approval.revokedAt != null) return false;
  if (typeof approval.id !== "string" || !APPROVAL_ID.test(approval.id)) return false;
  const time = new Date(approval.expiresAt).getTime();
  if (approval.expiresAt == null || !Number.isFinite(time) || time <= now.getTime()) return false;
  if (isLegacyExecutionScope(approval.scope)) return true;
  return isCodingExecutionScope(approval.scope) && approval.startingRef === "main";
}

function constraintsOf(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const items = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item !== item.trim() ||
      item.length === 0 ||
      item.length > 500
    ) {
      return null;
    }
    if (hasControlChar(item)) return null;
    items.push(item);
  }
  return items;
}

function sameGrant(approval, command) {
  const approvedConstraints = constraintsOf(approval.constraints);
  const requestedConstraints = constraintsOf(command.constraints);
  if (!approvedConstraints || !requestedConstraints) return false;
  if (
    approvedConstraints.length !== requestedConstraints.length ||
    approvedConstraints.some((item, index) => item !== requestedConstraints[index])
  ) {
    return false;
  }
  return (
    approval.userId === command.userId &&
    approval.provider === PROVIDER &&
    approval.objective === command.objective &&
    approval.repositoryUrl === command.repositoryUrl &&
    approval.startingRef === command.startingRef
  );
}

function validateCommand(command, actor, allowlist, now) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    fail("objective_invalid", "Execution objective is malformed");
  }
  if (!userIdOf(actor?.userId) || !userIdOf(command.userId) || actor.userId !== command.userId) {
    fail("unauthorized", "Execution requires the authorized user");
  }
  if (command.provider !== PROVIDER) {
    fail("provider_unsupported", "Execution provider is not supported");
  }
  if (!objectiveOf(command.objective)) {
    fail("objective_invalid", "Execution objective is malformed");
  }
  if (command.startingRef == null || command.startingRef === "") {
    fail("ref_missing", "Execution requires an approved starting ref");
  }
  if (!refOf(command.startingRef)) fail("ref_invalid", "Execution starting ref is invalid");
  if (command.environment != null || command.env != null || command.prUrl != null) {
    fail("scope_rejected", "Execution requires an explicit repository, not a named environment");
  }
  if (command.workOnCurrentBranch != null && command.workOnCurrentBranch !== false) {
    fail("scope_rejected", "Execution cannot work on the current branch");
  }
  if (command.merge === true || command.deploy === true) {
    fail("scope_rejected", "Execution cannot merge or deploy");
  }
  const coding = isCodingExecutionScope(command.approval?.scope);
  if (command.autoCreatePR === true && !coding) {
    fail("scope_rejected", "Execution cannot open a pull request");
  }
  if (
    command.autoCreatePR != null &&
    command.autoCreatePR !== false &&
    command.autoCreatePR !== true
  ) {
    fail("scope_rejected", "Execution cannot open a pull request");
  }
  if (coding && command.startingRef !== "main") {
    fail("ref_invalid", "Coding execution starts from main");
  }
  if (!approvalCurrent(command.approval, now) || !userIdOf(command.approval.userId)) {
    fail("approval_mismatch", "Approval does not cover this execution scope");
  }
  if (command.approval.userId !== command.userId) {
    fail("unauthorized", "Execution requires the authorized user");
  }
  if (!sameGrant(command.approval, command)) {
    fail("approval_mismatch", "Approval does not cover this execution scope");
  }
  if (typeof command.repositoryUrl !== "string") {
    fail("repository_not_allowed", "Execution repository is not on the allowlist");
  }
  if (isProtectedRepository(command.repositoryUrl)) {
    fail(
      "repository_forbidden",
      "Freedom Financial and XRP repositories cannot be execution targets"
    );
  }
  if (!isExactRepositoryUrl(command.repositoryUrl)) {
    fail("repository_not_allowed", "Execution repository is not on the allowlist");
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    fail("allowlist_missing", "Cursor execution repository allowlist is not configured");
  }
  if (!allowlist.includes(command.repositoryUrl)) {
    fail("repository_not_allowed", "Execution repository is not on the allowlist");
  }
  return {
    approvalId: command.approval.id,
    userId: command.userId,
    objective: command.objective,
    constraints: constraintsOf(command.constraints) ?? [],
    repositoryUrl: command.repositoryUrl,
    startingRef: command.startingRef,
    provider: PROVIDER,
    scope: coding
      ? {
          effect: "execute",
          workOnCurrentBranch: false,
          autoCreatePR: true,
          merge: false,
          deploy: false,
        }
      : {
          effect: "execute",
          workOnCurrentBranch: false,
          autoCreatePR: false,
        },
  };
}

function referenceOf(value) {
  if (!value || typeof value !== "object") return null;
  if (!AGENT_ID.test(value.agentId) || !RUN_ID.test(value.runId)) return null;
  return { agentId: value.agentId, runId: value.runId };
}

function submissionView(record, duplicate) {
  return {
    provider: PROVIDER,
    approvalId: record.approvalId,
    userId: record.userId,
    agentId: record.agentId,
    runId: record.runId,
    status: record.status,
    repositoryUrl: record.repositoryUrl,
    startingRef: record.startingRef,
    duplicate,
  };
}

function createBody(command, agentId, modelId) {
  const coding =
    isCodingExecutionScope(command.scope) &&
    command.startingRef === "main" &&
    command.scope.merge !== true &&
    command.scope.deploy !== true;
  const body = {
    prompt: { text: command.objective },
    repos: [{ url: command.repositoryUrl, startingRef: command.startingRef }],
    workOnCurrentBranch: false,
    autoCreatePR: coding,
  };
  if (coding) body.model = { id: modelId };
  if (typeof agentId === "string" && agentId) body.agentId = agentId;
  return body;
}

function platformGit(run) {
  const branches = [];
  const pullRequests = [];
  const list = run?.git?.branches;
  if (!Array.isArray(list)) return { branches, pullRequests };
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const repoUrl = typeof entry.repoUrl === "string" ? entry.repoUrl : null;
    if (typeof entry.branch === "string" && entry.branch.trim() !== "") {
      branches.push({ repoUrl, branch: entry.branch });
    }
    if (typeof entry.prUrl === "string" && entry.prUrl.trim() !== "") {
      pullRequests.push({ repoUrl, url: entry.prUrl });
    }
  }
  return { branches, pullRequests };
}

async function responseCode(response) {
  try {
    const parsed = JSON.parse(await response.text());
    const code = parsed?.code ?? parsed?.error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

export function createCursorCloudRuntime(options = {}) {
  const allowlist = normalizeAllowlist(options.allowlist);
  const timeoutMs = resolveTimeout(options.timeoutMs);
  if (!options.ledger || typeof options.ledger.begin !== "function") {
    fail("ledger_required", "Cursor execution requires a durable ledger");
  }
  const ledger = options.ledger;
  const reserveHold = options.reserveHold;
  const releaseHold = options.releaseHold;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const configuredKey = Object.prototype.hasOwnProperty.call(options, "apiKey")
    ? options.apiKey
    : undefined;

  function apiKey() {
    const value = configuredKey === undefined ? process.env.CURSOR_API_KEY : configuredKey;
    return typeof value === "string" && API_KEY.test(value) ? value : null;
  }

  async function send(path, { method, body, key }) {
    const headers = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    };
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetchImpl(`${BASE_URL}${path}`, init);
  }

  async function owned(reference, actor) {
    const ids = referenceOf(reference);
    if (!ids) fail("unknown_run", "Cursor run reference is not a stored execution");
    const record = await ledger.findRun(ids.agentId, ids.runId);
    if (!record) fail("unknown_run", "Cursor run reference is not a stored execution");
    if (!userIdOf(actor?.userId) || actor.userId !== record.userId) {
      fail("unauthorized", "Execution requires the authorized user");
    }
    return record;
  }

  async function readRun(record) {
    const key = apiKey();
    if (!key) fail("api_key_missing", "Cursor execution API key is not configured");
    const path = `/v1/agents/${encodeURIComponent(record.agentId)}/runs/${encodeURIComponent(record.runId)}`;
    let response;
    try {
      response = await send(path, { method: "GET", key });
    } catch {
      fail("network_error", "Cursor API request failed");
    }
    if (response.status === 401 || response.status === 403) {
      fail("authentication_failed", "Cursor API authentication failed");
    }
    if (response.status === 429) fail("rate_limited", "Cursor API rate limit exceeded");
    if (!response.ok) fail("request_rejected", "Cursor run request was rejected");
    let body;
    try {
      body = await response.json();
    } catch {
      fail("response_invalid", "Cursor run response was incomplete");
    }
    if (body?.id !== record.runId || body?.agentId !== record.agentId) {
      fail("response_invalid", "Cursor run response did not match the stored reference");
    }
    if (!isRunStatus(body.status)) fail("unknown_status", "Cursor returned an unknown run status");
    await ledger.markStatus(record.approvalId, body.status, body);
    if (isTerminalStatus(body.status)) await releaseObserved(record);
    return body;
  }

  async function releaseObserved(record) {
    if (typeof releaseHold !== "function" || !record?.approvalId || !record?.userId) return;
    await releaseHold({
      userId: record.userId,
      operationId: record.approvalId,
    }).catch(() => {});
  }

  async function resolveCodingModel(key) {
    let response;
    try {
      response = await send("/v1/models", { method: "GET", key });
    } catch {
      return { ok: false, code: "model_unavailable" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: "authentication_failed" };
    }
    if (!response.ok) return { ok: false, code: "model_unavailable" };
    let body;
    try {
      body = await response.json();
    } catch {
      return { ok: false, code: "model_unavailable" };
    }
    const id = selectCursorCodingModel(body?.items);
    if (!id) return { ok: false, code: "model_unavailable" };
    return { ok: true, id };
  }

  async function rejectReserved(approved, code) {
    await ledger.finish(approved.approvalId, "pending", {
      state: "rejected",
      agentId: null,
      runId: null,
      status: null,
    });
    const message =
      code === "model_unavailable"
        ? "Grok 4.7 is not available for this Cursor account"
        : code === "authentication_failed"
          ? "Cursor API authentication failed"
          : code === "reconciliation_required"
            ? "Cursor submission outcome is ambiguous and needs reconciliation"
            : "Coding spend could not be reserved";
    fail(code, message);
  }

  async function postReserved(approved, reservedId, key) {
    let held = false;
    let modelId = null;
    async function releaseHeld() {
      if (!held || typeof releaseHold !== "function") return;
      await releaseHold({
        userId: approved.userId,
        operationId: approved.approvalId,
      }).catch(() => {});
    }
    if (isCodingExecutionScope(approved.scope)) {
      if (typeof reserveHold !== "function") {
        if (typeof releaseHold === "function") {
          await releaseHold({
            userId: approved.userId,
            operationId: approved.approvalId,
          }).catch(() => {});
        }
        await rejectReserved(approved, "budget_unverified");
      }
      let hold;
      try {
        hold = await reserveHold({
          userId: approved.userId,
          operationId: approved.approvalId,
          scope: "cursor",
          periodType: "run",
          estimateUsd: options.cursorEstimateUsd,
        });
      } catch {
        hold = { ok: false, code: "budget_unverified" };
      }
      if (!hold?.ok) await rejectReserved(approved, hold?.code || "budget_unverified");
      held = hold.enforced === true;
      if (!reservedId && typeof releaseHold === "function") {
        await releaseHold({
          userId: approved.userId,
          operationId: approved.approvalId,
        }).catch(() => {});
        await rejectReserved(approved, "reconciliation_required");
      }
      const model = await resolveCodingModel(key);
      if (!model.ok) {
        await releaseHeld();
        await rejectReserved(approved, model.code);
      }
      modelId = model.id;
    }
    let response;
    try {
      response = await send("/v1/agents", {
        method: "POST",
        body: createBody(approved, reservedId, modelId),
        key,
      });
    } catch {
      await ledger.finish(approved.approvalId, "pending", {
        state: "ambiguous",
        agentId: reservedId,
        runId: null,
        status: null,
      });
      fail(
        "reconciliation_required",
        "Cursor submission outcome is ambiguous and needs reconciliation"
      );
    }

    if (response.status >= 500 || response.status === 408) {
      await ledger.finish(approved.approvalId, "pending", {
        state: "ambiguous",
        agentId: reservedId,
        runId: null,
        status: null,
      });
      fail(
        "reconciliation_required",
        "Cursor submission outcome is ambiguous and needs reconciliation"
      );
    }

    if (!response.ok) {
      const code = await responseCode(response);
      if (response.status === 409 && code === "agent_id_conflict") {
        await ledger.finish(approved.approvalId, "pending", {
          state: "ambiguous",
          agentId: reservedId,
          runId: null,
          status: null,
          code: "agent_id_conflict",
        });
        fail(
          "reconciliation_required",
          "Cursor submission outcome is ambiguous and needs reconciliation"
        );
      }
      await releaseHeld();
      await ledger.finish(approved.approvalId, "pending", {
        state: "rejected",
        agentId: reservedId,
        runId: null,
        status: null,
      });
      if (response.status === 401 || response.status === 403) {
        fail("authentication_failed", "Cursor API authentication failed");
      }
      if (response.status === 429) fail("rate_limited", "Cursor API rate limit exceeded");
      if (response.status === 409 && code === "agent_busy") {
        fail("agent_busy", "Cursor agent is busy");
      }
      fail("request_rejected", "Cursor execution request was rejected");
    }

    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const agentId = body?.agent?.id;
    const runId = body?.run?.id;
    const latest = body?.agent?.latestRunId;
    const status = body?.run?.status;
    const addressed =
      AGENT_ID.test(agentId) &&
      RUN_ID.test(runId) &&
      (latest == null || latest === runId) &&
      (reservedId == null || agentId === reservedId) &&
      isRunStatus(status);
    if (!addressed) {
      await ledger.finish(approved.approvalId, "pending", {
        state: "ambiguous",
        agentId: reservedId,
        runId: null,
        status: null,
      });
      fail(
        "reconciliation_required",
        "Cursor submission outcome is ambiguous and needs reconciliation"
      );
    }
    const finished = await ledger.finish(approved.approvalId, "pending", {
      state: "submitted",
      agentId,
      runId,
      status,
    });
    if (!finished.ok) {
      fail(
        "reconciliation_required",
        "Cursor submission outcome is ambiguous and needs reconciliation"
      );
    }
    if (isTerminalStatus(status)) await releaseObserved(finished.record);
    return submissionView(finished.record, false);
  }

  function resultView(record, run) {
    const git = platformGit(run);
    return {
      provider: PROVIDER,
      agentId: record.agentId,
      runId: record.runId,
      status: run.status,
      terminal: isTerminalStatus(run.status),
      statement: typeof run.result === "string" ? run.result : null,
      verified: false,
      testsPassed: null,
      branches: git.branches,
      pullRequests: git.pullRequests,
    };
  }

  return {
    provider: PROVIDER,
    effects: EXECUTION_EFFECTS,

    async submit(command, actor) {
      const approved = validateCommand(command, actor, allowlist, now());
      const key = apiKey();
      if (!key) fail("api_key_missing", "Cursor execution API key is not configured");
      if (approved.objective.includes(key) || approved.repositoryUrl.includes(key)) {
        fail("objective_invalid", "Execution objective is malformed");
      }
      const begun = await ledger.begin(approved.approvalId, {
        ...approved,
        state: "pending",
        agentId: null,
        runId: null,
        status: null,
      });
      if (begun.action === "duplicate") return submissionView(begun.record, true);
      if (begun.action === "unauthorized") {
        fail("unauthorized", "Execution requires the authorized user");
      }
      if (
        begun.action === "invalidated" ||
        begun.action === "absent" ||
        begun.action === "expired" ||
        begun.action === "closed"
      ) {
        fail("approval_mismatch", "Approval does not cover this execution scope");
      }
      if (begun.action === "blocked") {
        const ambiguous = begun.record?.state === "ambiguous";
        fail(
          ambiguous ? "reconciliation_required" : "submission_in_progress",
          ambiguous
            ? "Cursor submission outcome is ambiguous and needs reconciliation"
            : "Cursor submission is already in progress"
        );
      }
      if (begun.action !== "start") {
        fail(
          "reconciliation_required",
          "Cursor submission outcome is ambiguous and needs reconciliation"
        );
      }
      const reservedId = begun.record?.agentId ?? null;
      return postReserved(approved, reservedId, key);
    },

    async deliverReserved(record, actor) {
      if (!record || !userIdOf(actor?.userId) || actor.userId !== record.userId) {
        fail("unauthorized", "Execution requires the authorized user");
      }
      if (record.scope?.autoCreatePR === true && !isCodingExecutionScope(record.scope)) {
        fail("scope_rejected", "Execution cannot open a pull request");
      }
      if (typeof record.agentId !== "string" || record.agentId === "") {
        fail(
          "reconciliation_required",
          "Cursor submission outcome is ambiguous and needs reconciliation"
        );
      }
      if (record.runId) return submissionView(record, true);
      const key = apiKey();
      if (!key) fail("api_key_missing", "Cursor execution API key is not configured");
      return postReserved(
        {
          approvalId: record.approvalId,
          userId: record.userId,
          objective: record.objective,
          repositoryUrl: record.repositoryUrl,
          startingRef: record.startingRef,
          scope: record.scope,
        },
        record.agentId,
        key
      );
    },

    async getStatus(reference, actor) {
      const record = await owned(reference, actor);
      const run = await readRun(record);
      return {
        provider: PROVIDER,
        agentId: record.agentId,
        runId: record.runId,
        status: run.status,
        terminal: isTerminalStatus(run.status),
      };
    },

    async getResult(reference, actor) {
      const record = await owned(reference, actor);
      return resultView(record, await readRun(record));
    },

    async lookupPlatformAgent(agentId, actor) {
      if (typeof ledger.findAgent !== "function" || !AGENT_ID.test(agentId ?? "")) {
        fail("unknown_run", "Cursor run reference is not a stored execution");
      }
      const record = await ledger.findAgent(agentId);
      if (!record) fail("unknown_run", "Cursor run reference is not a stored execution");
      if (!userIdOf(actor?.userId) || actor.userId !== record.userId) {
        fail("unauthorized", "Execution requires the authorized user");
      }
      const key = apiKey();
      if (!key) fail("api_key_missing", "Cursor execution API key is not configured");
      let response;
      try {
        response = await send(`/v1/agents/${encodeURIComponent(agentId)}`, { method: "GET", key });
      } catch {
        fail("network_error", "Cursor API request failed");
      }
      if (response.status === 404) return { found: false, agentId, absenceProven: false };
      if (response.status === 401 || response.status === 403) {
        fail("authentication_failed", "Cursor API authentication failed");
      }
      if (response.status === 429) fail("rate_limited", "Cursor API rate limit exceeded");
      if (!response.ok) fail("request_rejected", "Cursor run request was rejected");
      let body;
      try {
        body = await response.json();
      } catch {
        fail("response_invalid", "Cursor run response was incomplete");
      }
      if (body?.id !== agentId) {
        fail("response_invalid", "Cursor run response did not match the stored reference");
      }
      const runId = typeof body.latestRunId === "string" ? body.latestRunId : null;
      if (runId && RUN_ID.test(runId) && typeof ledger.attachRun === "function") {
        await ledger.attachRun(record.approvalId, { agentId, runId });
      }
      return { found: true, agentId, runId: RUN_ID.test(runId ?? "") ? runId : null };
    },

    async cancel(reference, actor) {
      const record = await owned(reference, actor);
      const key = apiKey();
      if (!key) fail("api_key_missing", "Cursor execution API key is not configured");
      const path = `/v1/agents/${encodeURIComponent(record.agentId)}/runs/${encodeURIComponent(record.runId)}/cancel`;
      let response;
      try {
        response = await send(path, { method: "POST", key });
      } catch {
        fail("network_error", "Cursor API request failed");
      }
      if (response.status === 401 || response.status === 403) {
        fail("authentication_failed", "Cursor API authentication failed");
      }
      if (response.status === 429) fail("rate_limited", "Cursor API rate limit exceeded");
      if (response.status === 409) {
        const code = await responseCode(response);
        if (code === "run_not_cancellable") {
          fail("run_not_cancellable", "Cursor run cannot be cancelled");
        }
        fail("request_rejected", "Cursor execution request was rejected");
      }
      if (!response.ok) fail("request_rejected", "Cursor execution request was rejected");
      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (body?.id != null && body.id !== record.runId) {
        fail("response_invalid", "Cursor run response did not match the stored reference");
      }
      await ledger.markStatus(record.approvalId, "CANCELLED");
      await releaseObserved(record);
      return {
        provider: PROVIDER,
        agentId: record.agentId,
        runId: record.runId,
        status: "CANCELLED",
      };
    },
  };
}

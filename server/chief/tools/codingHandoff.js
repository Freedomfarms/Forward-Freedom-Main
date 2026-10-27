// Custom tools for the Cursor coding handoff. The model supplies requirements
// or a task id. It cannot choose a repository, merge, or deploy.

import { Capability } from "../core/capabilities.js";
import { BaseTool } from "./spec.js";
import {
  allowlistFor,
  createCodingHandoff,
  normalizeRequirements,
  repositoryUrlFor,
} from "../agents/codingHandoff.js";
import { createCursorCloudRuntime } from "../agents/cursorCloud.js";
import { isExactRepositoryUrl, isProtectedRepository } from "../agents/execution.js";
import { CODING_EXECUTION_SCOPE, ExecutionState, executionScopeHash } from "../agents/ledger.js";
import { createPrismaReleaseHold, createPrismaReserveHold } from "../models/budget.js";

const IGNORED = new Set(["userId", "user_id"]);

function argumentsOf(params, allowed) {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { error: "coding task input must be an object" };
  }
  const keys = Object.keys(params).filter((key) => !IGNORED.has(key));
  if (keys.some((key) => !allowed.has(key))) return { error: "unsupported coding task argument" };
  return { keys };
}

function resultOf(body) {
  return {
    output: JSON.stringify(body),
    isError: body?.available !== true,
  };
}

const ACTIVE_EXECUTION = new Set(["APPROVED", "SUBMITTING", "SUBMITTED", "AMBIGUOUS", "RUNNING"]);

function codingSnapshot(userId, objective, repositoryUrl) {
  return {
    userId,
    provider: "cursor-cloud",
    objective,
    constraints: ["Do not merge.", "Do not deploy."],
    repositoryUrl,
    startingRef: "main",
    scope: { ...CODING_EXECUTION_SCOPE },
  };
}

export function createCodingHandoffTools({
  env = process.env,
  fetchImpl = globalThis.fetch,
  handoff = null,
  ledger = null,
  reserveHold = null,
  releaseHold = null,
} = {}) {
  function runtime(context) {
    return (
      handoff ||
      createCodingHandoff({
        env,
        fetchImpl,
        memoryClient: context?.memoryClient || null,
        memoryStoreId: context?.memoryStoreId || null,
      })
    );
  }

  const submit = new BaseTool({
    isLocal: true,
    spec: {
      name: "coding_task_submit",
      description:
        "Delegate one coding change to Cursor and return the task id. Cursor opens an unmerged pull request on a new branch. Repeating the same requirements returns the current task. Pass new_attempt only after that task has finished or failed and the user wants another try. This does not merge or deploy. Do not pass a repository, URL, or user id.",
      category: "workforce",
      requiresConfirmation: true,
      requiredCapabilities: [Capability.CODING_HANDOFF],
      parameters: {
        type: "object",
        properties: {
          requirements: {
            type: "string",
            description: "What should be true when the pull request is ready for review.",
          },
          new_attempt: {
            type: "boolean",
            description:
              "True only when the user wants another try after the previous task for these requirements finished or failed.",
          },
        },
        required: ["requirements"],
      },
    },
    async execute(params, context) {
      if (!context?.userId)
        return resultOf({ available: false, error: "authenticated user is required" });
      const args = argumentsOf(params, new Set(["requirements", "new_attempt"]));
      if (args.error) return resultOf({ available: false, error: args.error });
      if (
        params?.new_attempt != null &&
        params.new_attempt !== true &&
        params.new_attempt !== false
      ) {
        return resultOf({ available: false, error: "unsupported coding task argument" });
      }
      if (context?.caller?.kind === "schedule") {
        return resultOf({ available: false, error: "schedule_cannot_grant", posted: false });
      }
      const decision = String(context?.approvalDecision || "");
      if (decision === "approved_for_session" || decision === "APPROVED_FOR_SESSION") {
        return resultOf({ available: false, error: "session_approval_rejected", posted: false });
      }
      if (context?.mutationApproved !== true) {
        return resultOf({ available: false, error: "confirmation_required", posted: false });
      }
      const store = context?.ledger || ledger;
      if (!store || typeof store.grant !== "function" || typeof store.begin !== "function") {
        return resultOf({ available: false, error: "ledger_required", posted: false });
      }
      const text = normalizeRequirements(params?.requirements);
      if (!text || text.length > 8000) {
        return resultOf({ available: false, error: "requirements_invalid", posted: false });
      }
      const repositoryUrl = repositoryUrlFor(env);
      if (
        !isExactRepositoryUrl(repositoryUrl) ||
        isProtectedRepository(repositoryUrl) ||
        !allowlistFor(env).includes(repositoryUrl)
      ) {
        return resultOf({ available: false, error: "repository_not_allowed", posted: false });
      }
      const snapshot = codingSnapshot(context.userId, text, repositoryUrl);
      try {
        const hash = executionScopeHash(snapshot);
        const latest =
          typeof store.findLatestByHash === "function"
            ? await store.findLatestByHash(context.userId, hash)
            : null;
        if (latest?.state === ExecutionState.APPROVED) {
          const begun = await store.begin(latest.approvalId, snapshot);
          if (begun.action !== "start") {
            return resultOf({
              available: false,
              error: begun.action || "approval_mismatch",
              posted: false,
              agentId: begun.record?.agentId || latest.agentId || null,
            });
          }
          return await deliver(store, begun.record, context.userId);
        }
        if (latest && ACTIVE_EXECUTION.has(latest.state)) {
          return resultOf({
            available: true,
            duplicate: true,
            posted: false,
            agentId: latest.agentId,
            approvalId: latest.approvalId,
            merged: false,
            deployed: false,
          });
        }
        if (latest && params?.new_attempt !== true && latest.state !== ExecutionState.APPROVED) {
          return resultOf({
            available: true,
            duplicate: true,
            posted: false,
            agentId: latest.agentId,
            error: "attempt_closed",
            merged: false,
            deployed: false,
          });
        }
        const granted = await store.grant({
          userId: context.userId,
          actorUserId: context.userId,
          approvalAction: "execute",
          provider: "cursor-cloud",
          objective: text,
          constraints: snapshot.constraints,
          repositoryUrl,
          startingRef: "main",
          scope: snapshot.scope,
        });
        const begun = await store.begin(granted.approvalId, snapshot);
        if (begun.action !== "start") {
          return resultOf({
            available: false,
            error: begun.action || "approval_mismatch",
            posted: false,
            agentId: begun.record?.agentId || null,
          });
        }
        return await deliver(store, begun.record, context.userId);
      } catch (error) {
        return resultOf({
          available: false,
          error: error?.code || "request_rejected",
          posted: false,
        });
      }

      async function deliver(store, record, userId) {
        const key = typeof env?.CURSOR_API_KEY === "string" ? env.CURSOR_API_KEY.trim() : "";
        if (!/^[^\s]{8,512}$/.test(key)) {
          return resultOf({
            available: true,
            posted: false,
            reserved: true,
            agentId: record?.agentId || null,
            approvalId: record?.approvalId || null,
            merged: false,
            deployed: false,
          });
        }
        const runtime = createCursorCloudRuntime({
          apiKey: key,
          allowlist: allowlistFor(env),
          ledger: typeof store.adapter === "function" ? store.adapter() : store,
          fetch: fetchImpl,
          reserveHold: reserveHold || createPrismaReserveHold(),
          releaseHold: releaseHold || createPrismaReleaseHold(),
        });
        const delivered = await runtime.deliverReserved(record, { userId });
        return resultOf({
          ...delivered,
          available: true,
          posted: true,
          merged: false,
          deployed: false,
        });
      }
    },
  });

  async function releaseTerminalTask(context, body) {
    const store = context?.ledger || ledger;
    const adapter = typeof store?.adapter === "function" ? store.adapter() : store;
    const agentId = typeof body?.agentId === "string" && body.agentId ? body.agentId : body?.taskId;
    if (!adapter || typeof adapter.findAgent !== "function" || typeof agentId !== "string") return;
    try {
      const record = await adapter.findAgent(agentId);
      if (!record || record.userId !== context.userId || typeof record.approvalId !== "string") return;
      const releaser = releaseHold || createPrismaReleaseHold();
      await releaser({ userId: record.userId, operationId: record.approvalId });
    } catch {
      // Status still returns. A later read retries the release.
    }
  }

  const status = new BaseTool({
    isLocal: true,
    spec: {
      name: "coding_task_status",
      description:
        "Read one Cursor coding task. Pass the task id from coding_task_submit, or the same requirements to find it. Returns status, branch, pull request URL, diff, and checks when those reads are configured. This does not merge or deploy.",
      category: "workforce",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.CODING_HANDOFF],
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task id returned by coding_task_submit." },
          requirements: {
            type: "string",
            description: "The requirements used to submit the task, if the task id is not at hand.",
          },
        },
      },
    },
    async execute(params, context) {
      if (!context?.userId)
        return resultOf({ available: false, error: "authenticated user is required" });
      const args = argumentsOf(params, new Set(["task_id", "requirements"]));
      if (args.error) return resultOf({ available: false, error: args.error });
      if (!params?.task_id && !params?.requirements) {
        return resultOf({ available: false, error: "task_id_invalid" });
      }
      try {
        const body = await runtime(context).status({
          userId: context.userId,
          taskId: params?.task_id,
          requirements: params?.requirements,
        });
        if (body?.terminal === true) await releaseTerminalTask(context, body);
        return resultOf(body);
      } catch {
        return resultOf({ available: false, error: "request_rejected" });
      }
    },
  });

  return [submit, status];
}

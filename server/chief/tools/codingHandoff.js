// Custom tools for the Cursor coding handoff. The model supplies requirements
// or a task id. It cannot choose a repository, merge, or deploy.

import { Capability } from "../core/capabilities.js";
import { BaseTool } from "./spec.js";
import { createCodingHandoff } from "../agents/codingHandoff.js";

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

export function createCodingHandoffTools({
  env = process.env,
  fetchImpl = globalThis.fetch,
  handoff = null,
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
        "Delegate one coding change to Cursor. Returns the task id. The same requirements return the existing task instead of starting another. Cursor opens a pull request on a new branch. This does not merge or deploy. Do not pass a repository, URL, or user id.",
      category: "workforce",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.CODING_HANDOFF],
      parameters: {
        type: "object",
        properties: {
          requirements: {
            type: "string",
            description: "What should be true when the pull request is ready for review.",
          },
        },
        required: ["requirements"],
      },
    },
    async execute(params, context) {
      if (!context?.userId) return resultOf({ available: false, error: "authenticated user is required" });
      const args = argumentsOf(params, new Set(["requirements"]));
      if (args.error) return resultOf({ available: false, error: args.error });
      try {
        return resultOf(await runtime(context).submit({ userId: context.userId, requirements: params?.requirements }));
      } catch {
        return resultOf({ available: false, error: "request_rejected" });
      }
    },
  });

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
      if (!context?.userId) return resultOf({ available: false, error: "authenticated user is required" });
      const args = argumentsOf(params, new Set(["task_id", "requirements"]));
      if (args.error) return resultOf({ available: false, error: args.error });
      if (!params?.task_id && !params?.requirements) {
        return resultOf({ available: false, error: "task_id_invalid" });
      }
      try {
        return resultOf(
          await runtime(context).status({
            userId: context.userId,
            taskId: params?.task_id,
            requirements: params?.requirements,
          })
        );
      } catch {
        return resultOf({ available: false, error: "request_rejected" });
      }
    },
  });

  return [submit, status];
}

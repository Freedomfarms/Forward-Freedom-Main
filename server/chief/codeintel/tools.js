// Capability wrappers. The model sends a path, ref, or query. The server
// chooses the repository and the read client.

import { Capability } from "../core/capabilities.js";
import { BaseTool } from "../tools/spec.js";
import { createCodeIntel } from "./index.js";

const IGNORED_KEYS = new Set(["userId", "user_id"]);

function argumentsOf(params, allowed) {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { error: "code input must be an object" };
  }
  const keys = Object.keys(params).filter((key) => !IGNORED_KEYS.has(key));
  if (keys.some((key) => !allowed.has(key))) {
    return { error: "unsupported code argument" };
  }
  return { keys };
}

function toolResult(result) {
  return {
    output: JSON.stringify(result.body),
    isError: result.isError === true,
    traceMeta: result.traceMeta,
  };
}

function requireUser(context) {
  if (context?.userId) return null;
  return {
    output: JSON.stringify({ error: "authenticated user is required" }),
    isError: true,
  };
}

export function createCodeTools(codeintel = createCodeIntel()) {
  return [codeTree(codeintel), codeRead(codeintel), codeSearch(codeintel)];
}

function codeTree(codeintel) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "code_tree",
      description:
        "List files and directories in the Freedom OS repository. Optional path narrows the listing. Optional ref is a branch, tag, or commit. This cannot accept a URL or a repository name, and it cannot modify the repository.",
      category: "code",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.CODE_READ],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Repository-relative directory prefix." },
          ref: {
            type: "string",
            description: "Branch, tag, or commit. Defaults to the configured ref.",
          },
        },
      },
    },
    async execute(params, context) {
      const missing = requireUser(context);
      if (missing) return missing;
      const args = argumentsOf(params, new Set(["path", "ref"]));
      if (args.error) return { output: JSON.stringify({ error: args.error }), isError: true };
      return toolResult(
        await codeintel.tree({ path: params?.path, ref: params?.ref, signal: context.signal })
      );
    },
  });
}

function codeRead(codeintel) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "code_read",
      description:
        "Read one file in the Freedom OS repository. path is repository-relative. Optional ref is a branch, tag, or commit. Use start_line and end_line together when the file is large. The maximum range is 200 lines. This cannot accept a URL or a repository name, and it cannot modify, commit, push, or deploy.",
      category: "code",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.CODE_READ],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "Repository-relative file path." },
          ref: {
            type: "string",
            description: "Branch, tag, or commit. Defaults to the configured ref.",
          },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
        },
        required: ["path"],
      },
    },
    async execute(params, context) {
      const missing = requireUser(context);
      if (missing) return missing;
      const args = argumentsOf(params, new Set(["path", "ref", "start_line", "end_line"]));
      if (args.error) return { output: JSON.stringify({ error: args.error }), isError: true };
      return toolResult(
        await codeintel.read({
          path: params?.path,
          ref: params?.ref,
          startLine: params?.start_line,
          endLine: params?.end_line,
          signal: context.signal,
        })
      );
    },
  });
}

function codeSearch(codeintel) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "code_search",
      description:
        "Search the Freedom OS repository for a literal string, symbol, route, or file name. Optional path limits the search to a prefix. Optional ref selects a branch. File-body search uses the default branch. This cannot accept a URL or a repository name, and it cannot modify the repository.",
      category: "code",
      requiresConfirmation: false,
      requiredCapabilities: [Capability.CODE_READ],
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Literal search text. Not a repository qualifier.",
          },
          path: { type: "string", description: "Optional repository-relative prefix." },
          ref: {
            type: "string",
            description: "Branch, tag, or commit. Defaults to the configured ref.",
          },
        },
        required: ["query"],
      },
    },
    async execute(params, context) {
      const missing = requireUser(context);
      if (missing) return missing;
      const args = argumentsOf(params, new Set(["query", "path", "ref"]));
      if (args.error) return { output: JSON.stringify({ error: args.error }), isError: true };
      return toolResult(
        await codeintel.search({
          query: params?.query,
          path: params?.path,
          ref: params?.ref,
          signal: context.signal,
        })
      );
    },
  });
}

// Read-only view of the configured Freedom OS repository.
// tree, read, and search are the whole API. Nothing here writes or executes.

import { createGithubReader } from "./github.js";
import {
  CODE_LIMITS,
  containsObviousSecret,
  isProtectedPath,
  normalizeRef,
  normalizeRepoPath,
  normalizeSearchQuery,
  readCodeConfig,
} from "./policy.js";

const UNAVAILABLE = "code intelligence is unavailable";
const PATH_UNAVAILABLE = "that path is not available";
const INVALID_PATH = "invalid path";
const INVALID_REF = "invalid ref";

export function createCodeIntel({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = readCodeConfig(env);
  const reader = config.enabled
    ? createGithubReader({
        token: config.token,
        owner: config.owner,
        repo: config.repo,
        fetchImpl,
      })
    : null;

  function meta(operation, fields, started, extra = {}) {
    return {
      operation,
      repository: config.repository,
      ref: fields.ref || config.defaultRef || "",
      path: fields.path || "",
      durationMs: Date.now() - started,
      ...extra,
    };
  }

  function unavailable(operation, fields, started) {
    return {
      isError: true,
      body: { error: UNAVAILABLE },
      traceMeta: meta(operation, fields, started),
    };
  }

  async function tree({ path, ref, signal } = {}) {
    const started = Date.now();
    const fields = { path: "", ref: "" };
    if (!reader) return unavailable("tree", fields, started);
    const safeRef = normalizeRef(ref, config.defaultRef);
    if (!safeRef) {
      return {
        isError: true,
        body: { error: INVALID_REF },
        traceMeta: meta("tree", fields, started),
      };
    }
    fields.ref = safeRef;
    const prefix = normalizeRepoPath(path);
    if (prefix == null) {
      return {
        isError: true,
        body: { error: INVALID_PATH },
        traceMeta: meta("tree", fields, started),
      };
    }
    fields.path = prefix;
    if (prefix && isProtectedPath(prefix)) {
      return {
        isError: true,
        body: { error: PATH_UNAVAILABLE },
        traceMeta: meta("tree", fields, started),
      };
    }
    const response = await reader.tree(safeRef, { signal });
    if (!response.ok) return remoteFailure("tree", fields, started, response);
    const entries = Array.isArray(response.body?.tree) ? response.body.tree : [];
    const visible = [];
    for (const entry of entries) {
      if (typeof entry?.path !== "string" || isProtectedPath(entry.path)) continue;
      if (containsObviousSecret(entry.path, config.token)) continue;
      if (prefix && entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) continue;
      if (entry.type !== "blob" && entry.type !== "tree") continue;
      visible.push({
        path: entry.path,
        type: entry.type === "tree" ? "directory" : "file",
        ...(typeof entry.size === "number" ? { size: entry.size } : {}),
      });
    }
    const truncated =
      response.body?.truncated === true || visible.length > CODE_LIMITS.maxTreeEntries;
    const returned = visible.slice(0, CODE_LIMITS.maxTreeEntries);
    return {
      isError: false,
      body: {
        repository: config.repository,
        ref: safeRef,
        truncated,
        total: visible.length,
        entries: returned,
      },
      traceMeta: meta("tree", fields, started, { bytes: returned.length, lines: returned.length }),
    };
  }

  async function read({ path, ref, startLine, endLine, signal } = {}) {
    const started = Date.now();
    const fields = { path: "", ref: "" };
    if (!reader) return unavailable("read", fields, started);
    const safeRef = normalizeRef(ref, config.defaultRef);
    if (!safeRef) {
      return {
        isError: true,
        body: { error: INVALID_REF },
        traceMeta: meta("read", fields, started),
      };
    }
    fields.ref = safeRef;
    const safePath = normalizeRepoPath(path, { required: true });
    if (!safePath) {
      return {
        isError: true,
        body: { error: INVALID_PATH },
        traceMeta: meta("read", fields, started),
      };
    }
    fields.path = safePath;
    if (isProtectedPath(safePath)) {
      return {
        isError: true,
        body: { error: PATH_UNAVAILABLE },
        traceMeta: meta("read", fields, started),
      };
    }
    const range = lineRange(startLine, endLine);
    if (range.error) {
      return {
        isError: true,
        body: { error: range.error },
        traceMeta: meta("read", fields, started),
      };
    }
    const response = await reader.file(safePath, safeRef, { signal });
    if (!response.ok) return remoteFailure("read", fields, started, response);
    const body = response.body;
    if (Array.isArray(body) || body?.type === "dir") {
      return {
        isError: true,
        body: { error: "path is a directory" },
        traceMeta: meta("read", fields, started),
      };
    }
    if (body?.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") {
      return {
        isError: true,
        body: {
          error: "file exceeds the read limit",
          path: safePath,
          ref: safeRef,
          maxLines: CODE_LIMITS.maxLines,
        },
        traceMeta: meta("read", fields, started, { bytes: numberOrZero(body?.size) }),
      };
    }
    if (numberOrZero(body.size) > CODE_LIMITS.maxFileBytes) {
      return tooLarge(fields, started, numberOrZero(body.size), null);
    }
    let decoded;
    try {
      decoded = Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8");
    } catch {
      return {
        isError: true,
        body: { error: "code intelligence failed" },
        traceMeta: meta("read", fields, started),
      };
    }
    if (Buffer.byteLength(decoded) > CODE_LIMITS.maxFileBytes) {
      return tooLarge(fields, started, Buffer.byteLength(decoded), null);
    }
    if (containsObviousSecret(decoded, config.token)) {
      return {
        isError: true,
        body: { error: PATH_UNAVAILABLE },
        traceMeta: meta("read", fields, started),
      };
    }
    const lines = decoded.split(/\r?\n/);
    if (
      !range.requested &&
      (lines.length > CODE_LIMITS.maxLines || decoded.length > CODE_LIMITS.maxResponseChars)
    ) {
      return tooLarge(fields, started, Buffer.byteLength(decoded), lines.length);
    }
    const start = range.requested ? range.start : 1;
    const end = range.requested ? Math.min(range.end, lines.length) : lines.length;
    if (range.requested && range.start > lines.length) {
      return {
        isError: true,
        body: { error: "line range is outside the file", path: safePath, lines: lines.length },
        traceMeta: meta("read", fields, started, { lines: lines.length }),
      };
    }
    const slice = lines.slice(start - 1, end);
    const content = slice.map((line, index) => `${start + index}|${line}`).join("\n");
    if (content.length > CODE_LIMITS.maxResponseChars) {
      return {
        isError: true,
        body: {
          error: "line range exceeds the read limit",
          path: safePath,
          ref: safeRef,
          maxLines: CODE_LIMITS.maxLines,
        },
        traceMeta: meta("read", fields, started, { lines: lines.length }),
      };
    }
    return {
      isError: false,
      body: {
        repository: config.repository,
        ref: safeRef,
        path: safePath,
        startLine: start,
        endLine: start + slice.length - 1,
        lines: lines.length,
        content,
      },
      traceMeta: meta("read", fields, started, {
        bytes: Buffer.byteLength(content),
        lines: slice.length,
      }),
    };
  }

  async function search({ query, path, ref, signal } = {}) {
    const started = Date.now();
    const fields = { path: "", ref: "" };
    if (!reader) return unavailable("search", fields, started);
    const safeQuery = normalizeSearchQuery(query);
    if (!safeQuery) {
      return {
        isError: true,
        body: { error: "invalid query" },
        traceMeta: meta("search", fields, started, { matches: 0 }),
      };
    }
    const safeRef = normalizeRef(ref, config.defaultRef);
    if (!safeRef) {
      return {
        isError: true,
        body: { error: INVALID_REF },
        traceMeta: meta("search", fields, started),
      };
    }
    fields.ref = safeRef;
    const prefix = normalizeRepoPath(path);
    if (prefix == null || (prefix && isProtectedPath(prefix))) {
      return {
        isError: true,
        body: { error: prefix == null ? INVALID_PATH : PATH_UNAVAILABLE },
        traceMeta: meta("search", fields, started),
      };
    }
    fields.path = prefix;
    if (safeRef !== config.defaultRef) {
      return searchPaths({ safeQuery, prefix, safeRef, fields, started, signal });
    }
    const qualifier = `"${safeQuery.replace(/["\\]/g, " ")}" repo:${config.owner}/${config.repo}${
      prefix ? ` path:${prefix}` : ""
    }`;
    const response = await reader.search(qualifier, { signal });
    if (!response.ok) return remoteFailure("search", fields, started, response);
    const items = Array.isArray(response.body?.items) ? response.body.items : [];
    const matches = [];
    for (const item of items) {
      if (matches.length >= CODE_LIMITS.maxSearchResults) break;
      const fullName = item?.repository?.full_name;
      if (fullName && fullName !== config.repository) continue;
      const itemPath = typeof item?.path === "string" ? item.path : "";
      if (!itemPath || isProtectedPath(itemPath)) continue;
      if (prefix && itemPath !== prefix && !itemPath.startsWith(`${prefix}/`)) continue;
      const fragment = textFragment(item);
      if (fragment && containsObviousSecret(fragment, config.token)) continue;
      const text =
        fragment.length > CODE_LIMITS.maxFragmentChars
          ? fragment.slice(0, CODE_LIMITS.maxFragmentChars)
          : fragment;
      matches.push({ path: itemPath, ...(text ? { text } : {}) });
    }
    return {
      isError: false,
      body: {
        repository: config.repository,
        ref: safeRef,
        contentSearch: true,
        truncated: items.length > matches.length || response.body?.incomplete_results === true,
        matches,
      },
      traceMeta: meta("search", fields, started, { matches: matches.length }),
    };
  }

  async function searchPaths({ safeQuery, prefix, safeRef, fields, started, signal }) {
    const response = await reader.tree(safeRef, { signal });
    if (!response.ok) return remoteFailure("search", fields, started, response);
    const needle = safeQuery.toLowerCase();
    const entries = Array.isArray(response.body?.tree) ? response.body.tree : [];
    const matches = [];
    let total = 0;
    for (const entry of entries) {
      if (entry?.type !== "blob" || typeof entry.path !== "string") continue;
      if (isProtectedPath(entry.path) || containsObviousSecret(entry.path, config.token)) continue;
      if (prefix && entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) continue;
      if (!entry.path.toLowerCase().includes(needle)) continue;
      total += 1;
      if (matches.length < CODE_LIMITS.maxSearchResults) matches.push({ path: entry.path });
    }
    return {
      isError: false,
      body: {
        repository: config.repository,
        ref: safeRef,
        contentSearch: false,
        note: "File-body search runs on the default branch. These matches are paths on the requested ref.",
        truncated: total > matches.length,
        matches,
      },
      traceMeta: meta("search", fields, started, { matches: matches.length }),
    };
  }

  function remoteFailure(operation, fields, started, response) {
    const error = response?.unavailable
      ? UNAVAILABLE
      : response?.missing
        ? "path not found"
        : response?.tooLarge
          ? "file exceeds the read limit"
          : "code intelligence failed";
    return {
      isError: true,
      body: { error },
      traceMeta: meta(operation, fields, started),
    };
  }

  function tooLarge(fields, started, bytes, lines) {
    return {
      isError: true,
      body: {
        error: "file exceeds the read limit",
        path: fields.path,
        ref: fields.ref,
        ...(typeof lines === "number" ? { lines } : {}),
        ...(typeof bytes === "number" ? { bytes } : {}),
        maxLines: CODE_LIMITS.maxLines,
        hint: "request start_line and end_line",
      },
      traceMeta: meta("read", fields, started, {
        ...(typeof bytes === "number" ? { bytes } : {}),
        ...(typeof lines === "number" ? { lines } : {}),
      }),
    };
  }

  return {
    enabled: config.enabled,
    repository: config.repository,
    defaultRef: config.defaultRef,
    tree,
    read,
    search,
  };
}

function lineRange(startLine, endLine) {
  const hasStart = startLine != null && startLine !== "";
  const hasEnd = endLine != null && endLine !== "";
  if (!hasStart && !hasEnd) return { requested: false };
  if (!hasStart || !hasEnd) return { error: "provide both start_line and end_line" };
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return { error: "line range must be integers" };
  }
  if (startLine < 1 || endLine < startLine) return { error: "invalid line range" };
  if (endLine - startLine + 1 > CODE_LIMITS.maxLines) {
    return { error: "line range exceeds the read limit" };
  }
  return { requested: true, start: startLine, end: endLine };
}

function textFragment(item) {
  const fragments = Array.isArray(item?.text_matches) ? item.text_matches : [];
  const text = fragments
    .map((match) => (typeof match?.fragment === "string" ? match.fragment : ""))
    .find((fragment) => fragment.trim());
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// CHIEF web_search — one read-only public web search, executed only by ToolExecutor.
//
// BUILD NEW. The CEO agent's Anthropic provider tool
// (server/agents/llm.js getWebSearchTools) is not used: it runs inside the
// Claude call, so GPT and Grok would not have it, and it never enters
// ToolExecutor. CHIEF keeps one tool inventory. This module calls a fixed
// search host with a server-side key. It does not fetch result URLs, submit
// forms, or accept a caller-supplied endpoint.
//
// Brave Search is the provider because the process already has fetch and no
// search SDK. Credentials are read here from the injected env, the same way
// server/chief/models/providers.js reads model keys: CHIEF_-prefixed first.
// The key is sent only as the Brave subscription header. It is not returned,
// logged, or copied into tool output.

import { Capability } from "../core/capabilities.js";
import { fenceUntrustedOutput, fencesOutput, scanInjection } from "../security/injection.js";
import { TaintLabel } from "../security/taint.js";
import { BaseTool } from "./spec.js";

export const WEB_SEARCH_UNAVAILABLE = "web search is currently unavailable";
export const WEB_SEARCH_FAILED = "web search failed";
export const WEB_SEARCH_QUERY_REQUIRED = "web search requires a query";

export const BRAVE_WEB_SEARCH_ORIGIN = "https://api.search.brave.com";
export const BRAVE_WEB_SEARCH_PATH = "/res/v1/web/search";

export const WEB_SEARCH_CREDENTIAL_ENV = Object.freeze([
  "CHIEF_BRAVE_SEARCH_API_KEY",
  "BRAVE_SEARCH_API_KEY",
]);

const QUERY_MAX = 400;
const SNIPPET_MAX = 500;
const TITLE_MAX = 200;
const DEFAULT_COUNT = 5;
const MAX_COUNT = 8;
const SECRET_MIN = 8;

const FRESHNESS = Object.freeze({
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
});

export const WEB_SEARCH_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description:
        "Public search query. Do not include secrets, account numbers, or private personal data.",
    },
    count: {
      type: "integer",
      minimum: 1,
      maximum: MAX_COUNT,
      description: "How many results to return, from 1 to 8. Defaults to 5.",
    },
    freshness: {
      type: "string",
      enum: ["day", "week", "month", "year"],
      description: "Optional recency filter. Use day for news from today.",
    },
  },
  required: ["query"],
});

export function resolveWebSearchCredential(env = process.env) {
  for (const name of WEB_SEARCH_CREDENTIAL_ENV) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim() !== "") {
      return { name, apiKey: value.trim() };
    }
  }
  return null;
}

export function createWebSearchClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return {
    async search({ query, count, freshness, signal } = {}) {
      const credential = resolveWebSearchCredential(env);
      if (!credential) return { ok: false, unavailable: true };
      if (typeof fetchImpl !== "function") return { ok: false, failed: true };

      const safeQuery = redact(query, credential.apiKey).trim();
      if (!safeQuery) return { ok: false, failed: true };
      const url = new URL(BRAVE_WEB_SEARCH_PATH, BRAVE_WEB_SEARCH_ORIGIN);
      if (url.origin !== BRAVE_WEB_SEARCH_ORIGIN) return { ok: false, failed: true };
      url.searchParams.set("q", safeQuery);
      url.searchParams.set("count", String(count));
      if (freshness) url.searchParams.set("freshness", freshness);
      if (url.origin !== BRAVE_WEB_SEARCH_ORIGIN || url.toString().includes(credential.apiKey)) {
        return { ok: false, failed: true };
      }

      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": credential.apiKey,
          },
          signal,
        });
      } catch {
        return { ok: false, failed: true };
      }

      if (response.status === 401 || response.status === 403) {
        await discardBody(response);
        return { ok: false, unavailable: true };
      }
      if (!response.ok) {
        await discardBody(response);
        return { ok: false, failed: true };
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, failed: true };
      }
      const rows = payload?.web?.results;
      if (!Array.isArray(rows)) return { ok: false, failed: true };

      return {
        ok: true,
        provider: "brave",
        query: safeQuery,
        results: rows
          .slice(0, MAX_COUNT)
          .map((row) => normalizeResult(row, credential.apiKey))
          .filter((row) => row !== null),
      };
    },
  };
}

export function createWebSearchTool(client = createWebSearchClient()) {
  return new BaseTool({
    isLocal: true,
    spec: {
      name: "web_search",
      description:
        "Search the public web and return titles, source links, and snippets. Read-only. Use this for current events, news, markets, companies, and anything that may have changed. Do not include secrets or private personal data in the query. If the result says web search is unavailable or failed, tell the user and do not invent sources or results.",
      category: "web",
      requiresConfirmation: false,
      timeoutSeconds: 20,
      requiredCapabilities: [Capability.WEB_SEARCH],
      parameters: WEB_SEARCH_PARAMETERS,
    },
    async execute(params, context) {
      const parsed = parseWebSearchArguments(params);
      if (parsed.error) return { output: parsed.error, isError: true };
      let outcome;
      try {
        outcome = await client.search({
          query: parsed.query,
          count: parsed.count,
          freshness: parsed.freshness,
          signal: context?.signal,
        });
      } catch {
        return failedResult();
      }
      if (!outcome || outcome.unavailable) {
        return { output: WEB_SEARCH_UNAVAILABLE, isError: true };
      }
      if (!outcome.ok || !Array.isArray(outcome.results)) return failedResult();
      const output = fenceSearchOutput(
        JSON.stringify({
          provider: outcome.provider === "brave" ? "brave" : "web",
          query: typeof outcome.query === "string" ? outcome.query : parsed.query,
          results: outcome.results
            .map((row) => ({
              title: clip(row?.title, TITLE_MAX),
              url: publicHttpUrl(row?.url),
              snippet: clip(row?.snippet, SNIPPET_MAX),
            }))
            .filter((row) => row.title && row.url),
        })
      );
      return { output, sessionTaint: [TaintLabel.EXTERNAL] };
    },
  });
}

export function parseWebSearchArguments(params) {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return { error: WEB_SEARCH_QUERY_REQUIRED };
  }
  if (typeof params.query !== "string" || params.query.trim() === "") {
    return { error: WEB_SEARCH_QUERY_REQUIRED };
  }
  const query = params.query.trim();
  if (query.length > QUERY_MAX) return { error: "web search query is too long" };
  const count = parseCount(params.count);
  if (count === null) return { error: "web search count must be an integer from 1 to 8" };
  const freshness = parseFreshness(params.freshness);
  if (freshness === null) {
    return { error: "web search freshness must be day, week, month, or year" };
  }
  return { query, count, freshness };
}

function parseCount(value) {
  if (value == null || value === "") return DEFAULT_COUNT;
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > MAX_COUNT) return null;
  return number;
}

function parseFreshness(value) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") return null;
  return Object.prototype.hasOwnProperty.call(FRESHNESS, value) ? FRESHNESS[value] : null;
}

function normalizeResult(row, apiKey) {
  const title = redact(clip(row?.title, TITLE_MAX), apiKey);
  const snippet = redact(clip(row?.description ?? row?.snippet, SNIPPET_MAX), apiKey);
  const url = publicHttpUrl(redact(typeof row?.url === "string" ? row.url : "", apiKey));
  if (!title || !url) return null;
  return { title, url, snippet };
}

function publicHttpUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  if (parsed.username || parsed.password) return "";
  return parsed.toString();
}

function clip(value, max) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function redact(text, secret) {
  if (!secret || secret.length < SECRET_MIN) return text;
  return text.split(secret).join("[redacted]");
}

function fenceSearchOutput(output) {
  const scan = scanInjection(output);
  if (fencesOutput(scan.threatLevel)) return fenceUntrustedOutput(output);
  return output;
}

async function discardBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The status is already the result. A body that cannot be closed changes nothing.
  }
}

function failedResult() {
  return {
    output: WEB_SEARCH_FAILED,
    isError: true,
    sessionTaint: [TaintLabel.EXTERNAL],
  };
}

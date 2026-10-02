// GitHub read client. GET against api.github.com for one configured repository.
// There is no method argument, no caller-supplied URL, and no write route.

import { CODE_LIMITS } from "./policy.js";

const GITHUB_API = "https://api.github.com";

function failure() {
  return { ok: false, failed: true };
}

export function createGithubReader({ token, owner, repo, fetchImpl = globalThis.fetch } = {}) {
  const prefix = `/repos/${owner}/${repo}`;

  async function githubGet(pathname, { accept, signal } = {}) {
    if (typeof fetchImpl !== "function") return failure();
    if (typeof pathname !== "string" || !pathname.startsWith("/")) return failure();
    let url;
    try {
      url = new URL(pathname, GITHUB_API);
    } catch {
      return failure();
    }
    if (url.origin !== GITHUB_API || url.username || url.password) return failure();
    const treeOk = url.pathname.startsWith(`${prefix}/git/trees/`);
    const fileOk = url.pathname.startsWith(`${prefix}/contents/`);
    const searchOk =
      url.pathname === "/search/code" &&
      String(url.searchParams.get("q") || "").includes(`repo:${owner}/${repo}`);
    if ((!treeOk && !fileOk && !searchOk) || url.pathname.includes("..")) return failure();
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: accept || "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Freedom-OS-CHIEF",
        },
        signal,
      });
    } catch {
      return failure();
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      await discard(response);
      return { ok: false, unavailable: true };
    }
    if (response.status === 404) {
      await discard(response);
      return { ok: false, missing: true };
    }
    if (!response.ok) {
      await discard(response);
      return failure();
    }
    const length = Number(response.headers?.get?.("content-length") || 0);
    if (length > CODE_LIMITS.maxGithubBodyBytes) {
      await discard(response);
      return { ok: false, tooLarge: true };
    }
    let text;
    try {
      text = await response.text();
    } catch {
      return failure();
    }
    if (text.length > CODE_LIMITS.maxGithubBodyBytes) return { ok: false, tooLarge: true };
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return failure();
    }
  }

  return {
    tree(ref, { signal } = {}) {
      return githubGet(`${prefix}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { signal });
    },
    file(path, ref, { signal } = {}) {
      const encoded = path
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
      return githubGet(`${prefix}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, { signal });
    },
    search(query, { signal } = {}) {
      const params = new URLSearchParams();
      params.set("q", query);
      params.set("per_page", String(CODE_LIMITS.maxSearchResults));
      return githubGet(`/search/code?${params.toString()}`, {
        accept: "application/vnd.github.text-match+json",
        signal,
      });
    },
  };
}

async function discard(response) {
  try {
    await response.text?.();
  } catch {
    // The status is enough. The body is not used.
  }
}

// Read-only view of a repository checkout on disk.
// Used only when no GitHub read token is configured. No writes, no spawn.

import { existsSync, statSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { CODE_LIMITS, isProtectedPath, readCodeConfig } from "../codeintel/policy.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const MARKER = path.join("server", "chief", "codeintel", "policy.js");
const SEARCH_READ_BYTES = 200_000;
const SEARCH_VISIT_MAX = 400;

function usableDirectory(candidate) {
  if (!candidate) return null;
  try {
    return statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

export function resolveLocalCodeRoot(env = process.env) {
  const configured =
    typeof env?.CHIEF_CODE_LOCAL_ROOT === "string" ? env.CHIEF_CODE_LOCAL_ROOT.trim() : "";
  if (configured) return usableDirectory(configured);
  const cwd = process.cwd();
  if (existsSync(path.join(cwd, MARKER))) return usableDirectory(cwd);
  return null;
}

export function codeSourceAvailable(env = process.env) {
  if (readCodeConfig(env).enabled === true) return true;
  return resolveLocalCodeRoot(env) != null;
}

function insideRoot(rootReal, candidateReal) {
  const relative = path.relative(rootReal, candidateReal);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function posixPath(value) {
  return value.split(path.sep).join("/");
}

export function createLocalCodeReader({ root, repository } = {}) {
  let rootRealPromise = null;
  function rootReal() {
    if (!rootRealPromise) rootRealPromise = realpath(root);
    return rootRealPromise;
  }

  async function locate(rel) {
    const base = await rootReal();
    const joined = path.resolve(base, rel);
    const lexical = path.relative(base, joined);
    if (lexical.startsWith("..") || path.isAbsolute(lexical)) return null;
    return { base, joined };
  }

  async function walk() {
    const entries = [];
    async function visit(rel) {
      const location = await locate(rel);
      if (!location) return;
      let info;
      try {
        info = await lstat(location.joined);
      } catch {
        return;
      }
      if (info.isSymbolicLink()) return;
      const posix = posixPath(rel);
      if (info.isDirectory()) {
        if (rel && (SKIP_DIRS.has(path.basename(rel)) || isProtectedPath(posix))) return;
        let names;
        try {
          names = await readdir(location.joined);
        } catch {
          return;
        }
        if (rel) entries.push({ path: posix, type: "tree" });
        for (const name of names) {
          if (!rel && SKIP_DIRS.has(name)) continue;
          await visit(rel ? path.join(rel, name) : name);
        }
        return;
      }
      if (!info.isFile() || isProtectedPath(posix)) return;
      entries.push({ path: posix, type: "blob", size: info.size });
    }
    await visit("");
    return entries;
  }

  return {
    local: true,
    async tree() {
      try {
        return { ok: true, body: { tree: await walk(), truncated: false } };
      } catch {
        return { ok: false, unavailable: true };
      }
    },
    async file(filePath) {
      try {
        const location = await locate(filePath);
        if (!location) return { ok: false, missing: true };
        const info = await lstat(location.joined);
        if (info.isSymbolicLink()) return { ok: false, missing: true };
        if (info.isDirectory()) return { ok: true, body: { type: "dir" } };
        if (!info.isFile()) return { ok: false, missing: true };
        const real = await realpath(location.joined);
        if (!insideRoot(location.base, real)) return { ok: false, missing: true };
        if (info.size > CODE_LIMITS.maxFileBytes) return { ok: false, tooLarge: true };
        const bytes = await readFile(real);
        return {
          ok: true,
          body: {
            type: "file",
            encoding: "base64",
            size: bytes.length,
            content: bytes.toString("base64"),
          },
        };
      } catch (error) {
        if (error?.code === "ENOENT") return { ok: false, missing: true };
        return { ok: false, failed: true };
      }
    },
    async search(query, { prefix = "" } = {}) {
      const needle = String(query || "")
        .trim()
        .toLowerCase();
      if (!needle) return { ok: true, body: { items: [], incomplete_results: false } };
      try {
        const entries = await walk();
        const items = [];
        let visited = 0;
        let incomplete = false;
        for (const entry of entries) {
          if (entry.type !== "blob") continue;
          if (prefix && entry.path !== prefix && !entry.path.startsWith(`${prefix}/`)) continue;
          const pathHit = entry.path.toLowerCase().includes(needle);
          let fragment = "";
          if (!pathHit) {
            if (entry.size > SEARCH_READ_BYTES) continue;
            if (visited >= SEARCH_VISIT_MAX) {
              incomplete = true;
              break;
            }
            visited += 1;
            const loaded = await this.file(entry.path);
            if (!loaded.ok || loaded.body?.encoding !== "base64") continue;
            const text = Buffer.from(loaded.body.content, "base64").toString("utf8");
            if (text.includes("\0")) continue;
            const index = text.toLowerCase().indexOf(needle);
            if (index < 0) continue;
            fragment = text
              .slice(Math.max(0, index - 40), index + needle.length + 80)
              .replace(/\s+/g, " ")
              .trim();
          } else {
            fragment = entry.path;
          }
          items.push({
            path: entry.path,
            repository: { full_name: repository },
            text_matches: [{ fragment }],
          });
          if (items.length >= CODE_LIMITS.maxSearchResults) {
            incomplete = true;
            break;
          }
        }
        return { ok: true, body: { items, incomplete_results: incomplete } };
      } catch {
        return { ok: false, unavailable: true };
      }
    },
  };
}

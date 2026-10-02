// Path, ref, and secret rules for read-only repository access.
// The repository identity is server configuration. These checks never fetch.

export const CODE_LIMITS = Object.freeze({
  maxPathLength: 512,
  maxRefLength: 128,
  maxQueryLength: 160,
  maxTreeEntries: 300,
  maxLines: 200,
  maxResponseChars: 20_000,
  maxFileBytes: 1_000_000,
  maxSearchResults: 8,
  maxFragmentChars: 240,
  maxGithubBodyBytes: 5_000_000,
});

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PATH_SEGMENT = /^[A-Za-z0-9._@~+-]+$/;
const SCOPE_QUALIFIER = /\b(?:repo|org|user|owner|is|language)\s*:/i;

const PROTECTED_PATH = [
  /(^|\/)\.env($|\.|\/)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.git($|\/)/i,
  /(^|\/)\.secrets($|\/)/i,
  /(^|\/)secrets\//i,
  /\.(?:pem|key|p12|pfx|keystore)$/i,
  /(^|\/)id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)service-account(?:[-.].*)?\.json$/i,
  /(^|\/)[^/]*-credentials\.json$/i,
  /(^|\/)\.plaid-store\.json$/i,
  /(^|\/)firebase-adminsdk[-.].*\.json$/i,
  /(^|\/)auth\.json$/i,
];

const OBVIOUS_SECRET = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

export function parseRepository(value) {
  if (typeof value !== "string") return null;
  const repository = value.trim();
  if (!REPOSITORY_PATTERN.test(repository)) return null;
  if (repository.includes("..") || repository.includes("://")) return null;
  const [owner, repo] = repository.split("/");
  return { owner, repo, repository: `${owner}/${repo}` };
}

export function normalizeRef(value, defaultRef) {
  const ref = value == null || value === "" ? defaultRef : value;
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (!trimmed || trimmed.length > CODE_LIMITS.maxRefLength) return null;
  if (
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.includes("://") ||
    trimmed.includes("@") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.includes(" ") ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.startsWith("-")
  ) {
    return null;
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function normalizeRepoPath(value, { required = false } = {}) {
  if (value == null || value === "") return required ? null : "";
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/^\.\//, "");
  if (!path) return required ? null : "";
  if (path.length > CODE_LIMITS.maxPathLength) return null;
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("://") ||
    path.includes("\0") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    return null;
  }
  const parts = path.split("/");
  if (parts.some((part) => !PATH_SEGMENT.test(part) || part === "." || part === "..")) return null;
  return parts.join("/");
}

export function isProtectedPath(path) {
  return PROTECTED_PATH.some((pattern) => pattern.test(path));
}

export function containsObviousSecret(text, token = "") {
  const value = String(text ?? "");
  if (token && token.length >= 8 && value.includes(token)) return true;
  return OBVIOUS_SECRET.some((pattern) => pattern.test(value));
}

export function normalizeSearchQuery(value) {
  if (typeof value !== "string") return null;
  const query = value.trim();
  if (!query || query.length > CODE_LIMITS.maxQueryLength) return null;
  if (query.includes("\0") || query.includes("\n") || query.includes("://")) return null;
  if (SCOPE_QUALIFIER.test(query)) return null;
  return query;
}

export function readCodeConfig(env = process.env) {
  const repository = parseRepository(
    env?.CHIEF_CODE_REPOSITORY || "Freedomfarms/Forward-Freedom-Main"
  );
  const defaultRef = normalizeRef(env?.CHIEF_CODE_DEFAULT_REF || "main", "main");
  const token =
    typeof env?.CHIEF_CODE_READ_TOKEN === "string" ? env.CHIEF_CODE_READ_TOKEN.trim() : "";
  if (!repository || !defaultRef) return { enabled: false, repository: null, defaultRef: null };
  if (!token) {
    return { enabled: false, repository: repository.repository, defaultRef, token: "" };
  }
  return {
    enabled: true,
    token,
    owner: repository.owner,
    repo: repository.repo,
    repository: repository.repository,
    defaultRef,
  };
}

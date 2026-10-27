// Shared-wiki documentation gate for project pull requests.
//
// Cursor and Codex both run this script. It does not call a model. The coding
// session that made the change writes any wiki pull request; this module
// classifies the diff and GitHub Actions records the result.
//
//   node scripts/wiki-sync.mjs classify
//   node scripts/wiki-sync.mjs check
//
// classify prints whether the diff is neutral or wiki-required.
// check writes wiki-sync-result.json and exits 1 when documentation is not
// complete. A missing wiki token fails closed only when an update is required.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WIKI_REPO = "Freedomfarms/ai-development-wiki";

export const CATEGORY_ORDER = [
  "architecture",
  "integrations",
  "agent-capabilities",
  "database-memory",
  "security-permissions",
  "workflows-decisions",
];

// `always` matches every diff status. `presence` matches added, deleted, and
// renamed files so an in-place bug fix in an existing module stays neutral.
export const RULES = [
  { category: "architecture", when: "always", pattern: /^docs\/adr\// },
  { category: "architecture", when: "always", pattern: /^docs\/CHIEF_ARCHITECTURE\.md$/ },
  { category: "architecture", when: "always", pattern: /^docs\/FREEDOM_OS\.md$/ },
  { category: "architecture", when: "always", pattern: /^docs\/CHIEF_CONTROL_PLANE_PLAN\.md$/ },
  {
    category: "architecture",
    when: "always",
    pattern: /^docs\/CHIEF_GROK_WORKFORCE_ARCHITECTURE\.md$/,
  },
  { category: "architecture", when: "always", pattern: /^docs\/FREEDOM_BRAIN_PLAN\.md$/ },
  { category: "architecture", when: "always", pattern: /^docs\/FREEDOM_BRAIN_V2\.md$/ },
  { category: "architecture", when: "always", pattern: /^docs\/CEO_WORLD_MODEL_OWNERSHIP\.md$/ },
  { category: "architecture", when: "always", pattern: /^src\/routing\// },
  { category: "architecture", when: "always", pattern: /^vercel\.json$/ },

  { category: "integrations", when: "always", pattern: /^server\/plaidClient\.js$/ },
  { category: "integrations", when: "always", pattern: /^server\/chief\/connectors\// },
  {
    category: "integrations",
    when: "always",
    pattern: /^server\/chief\/agents\/(?:cursorCloud|grokbot|grokbotConnection)\.js$/,
  },
  { category: "integrations", when: "always", pattern: /^server\/chief\/voice\/elevenlabs\.js$/ },
  { category: "integrations", when: "presence", pattern: /^server\/plaid\// },
  { category: "integrations", when: "presence", pattern: /^server\/integrations\// },
  { category: "integrations", when: "presence", pattern: /^src\/utils\/plaid/ },
  { category: "integrations", when: "presence", pattern: /^server\/chief\/voice\// },

  { category: "agent-capabilities", when: "always", pattern: /^server\/capabilities\// },
  { category: "agent-capabilities", when: "always", pattern: /^server\/chief\/capabilities\// },
  {
    category: "agent-capabilities",
    when: "always",
    pattern: /^server\/chief\/tools\/(?:spec|inventory|builtin)\.js$/,
  },
  {
    category: "agent-capabilities",
    when: "always",
    pattern: /^server\/chief\/skills\/(?:catalog|index)\.js$/,
  },
  {
    category: "agent-capabilities",
    when: "always",
    pattern: /^server\/chief\/core\/capabilities\.js$/,
  },
  {
    category: "agent-capabilities",
    when: "always",
    pattern: /^server\/agents\/agentDefinition\.js$/,
  },
  { category: "agent-capabilities", when: "presence", pattern: /^server\/chief\/tools\// },
  { category: "agent-capabilities", when: "presence", pattern: /^server\/chief\/skills\// },
  { category: "agent-capabilities", when: "presence", pattern: /^server\/agents\// },

  { category: "database-memory", when: "always", pattern: /^prisma\// },
  { category: "database-memory", when: "always", pattern: /^server\/db\/schemaCapabilities\.js$/ },
  {
    category: "database-memory",
    when: "always",
    pattern: /^server\/chief\/managed\/memoryStore\.js$/,
  },
  { category: "database-memory", when: "presence", pattern: /^server\/chief\/memory\// },
  { category: "database-memory", when: "presence", pattern: /^server\/memory\// },

  { category: "security-permissions", when: "always", pattern: /^docs\/SECURITY\.md$/ },
  { category: "security-permissions", when: "always", pattern: /^docs\/RLS_ROLLOUT\.md$/ },
  {
    category: "security-permissions",
    when: "always",
    pattern: /^server\/chief\/security\/(?:grants|module-access|room-access|boundary|audit)\.js$/,
  },
  { category: "security-permissions", when: "presence", pattern: /^server\/chief\/security\// },

  { category: "workflows-decisions", when: "always", pattern: /^\.github\/workflows\// },
  { category: "workflows-decisions", when: "always", pattern: /^AGENTS\.md$/ },
  { category: "workflows-decisions", when: "always", pattern: /^\.cursor\/rules\// },
  { category: "workflows-decisions", when: "always", pattern: /^docs\/SHARED_WIKI\.md$/ },
  { category: "workflows-decisions", when: "always", pattern: /^scripts\/cloud-agent-wiki\.sh$/ },
  { category: "workflows-decisions", when: "always", pattern: /^scripts\/wiki-sync\.mjs$/ },
];

const IGNORE = [
  /^test\//,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /^design-references\//,
  /^third_party\//,
  /^src\/third_party\//,
];

const PRESENCE_STATUS = new Set(["A", "D", "R", "C"]);

export function parseNameStatus(text) {
  const changes = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0][0];
    if (status === "R" || status === "C") {
      changes.push({ path: parts[2], previousPath: parts[1], status });
    } else {
      changes.push({ path: parts[1], status });
    }
  }
  return changes;
}

export function dependencyNamesChanged(beforeText, afterText) {
  const names = (text) => {
    if (!text) return new Set();
    const pkg = JSON.parse(text);
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
  };
  let before;
  let after;
  try {
    before = names(beforeText);
    after = names(afterText);
  } catch {
    return true;
  }
  if (before.size !== after.size) return true;
  for (const name of before) {
    if (!after.has(name)) return true;
  }
  return false;
}

function ignored(filePath) {
  return IGNORE.some((pattern) => pattern.test(filePath));
}

export function classifyChanges(changes) {
  const matches = [];
  const seen = new Set();
  const add = (match) => {
    const key = `${match.category}\0${match.path}\0${match.status}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push(match);
  };

  for (const change of changes) {
    const status = change.status || "M";
    const paths = [change.path, change.previousPath].filter(Boolean);
    for (const filePath of paths) {
      if (ignored(filePath)) continue;
      if (
        filePath === change.path &&
        change.path === "package.json" &&
        change.dependencyNamesChanged
      ) {
        add({ path: filePath, status, category: "integrations" });
      }
      for (const rule of RULES) {
        if (rule.when === "presence" && !PRESENCE_STATUS.has(status)) continue;
        if (!rule.pattern.test(filePath)) continue;
        add({ path: filePath, status, category: rule.category });
      }
    }
  }

  const categories = CATEGORY_ORDER.filter((category) =>
    matches.some((match) => match.category === category)
  );
  return {
    impact: categories.length ? "wiki-required" : "neutral",
    categories,
    matches,
  };
}

export function parseWikiMarker(body) {
  if (!body) return null;
  const match = String(body).match(/<!--\s*wiki-sync\s*-->([\s\S]*?)<!--\s*\/wiki-sync\s*-->/);
  if (!match) return null;
  const block = match[1];
  const resultMatch = block.match(/^\s*result:\s*(no-update-required|update-required)\s*$/m);
  const reasonMatch = block.match(/^\s*reason:\s*(.+)\s*$/m);
  const wikiPrMatch = block.match(/^\s*wiki_pr:\s*(\S+)\s*$/m);
  if (!resultMatch) {
    return { error: "result must be no-update-required or update-required" };
  }
  return {
    result: resultMatch[1],
    reason: reasonMatch ? reasonMatch[1].trim() : "",
    wikiPr: wikiPrMatch ? wikiPrMatch[1].trim() : "",
  };
}

export function parseWikiPrUrl(value) {
  if (!value) return null;
  const cleaned = String(value)
    .trim()
    .replace(/[).,]+$/, "");
  const match = cleaned.match(
    /^https:\/\/github\.com\/Freedomfarms\/ai-development-wiki\/pull\/(\d+)\/?$/
  );
  if (!match) return null;
  return {
    repo: WIKI_REPO,
    number: Number(match[1]),
    url: `https://github.com/${WIKI_REPO}/pull/${match[1]}`,
  };
}

export function wikiBodyReferencesSource(body, sourcePr) {
  if (!sourcePr) return true;
  const text = body || "";
  const numberMatch = Boolean(
    sourcePr.repo &&
    sourcePr.number &&
    (text.includes(`${sourcePr.repo}#${sourcePr.number}`) ||
      text.includes(`https://github.com/${sourcePr.repo}/pull/${sourcePr.number}`))
  );
  const branchMatch = Boolean(sourcePr.branch && text.includes(sourcePr.branch));
  if (!sourcePr.number && !sourcePr.branch) return true;
  return numberMatch || branchMatch;
}

export function effectiveImpact(classification, marker) {
  if (classification.impact === "wiki-required") return "wiki-required";
  if (marker?.error) return "wiki-required";
  if (marker?.result === "update-required") return "wiki-required";
  return "neutral";
}

function blocked(fields, reason) {
  return {
    ok: false,
    result: "blocked",
    documentationComplete: false,
    impact: "wiki-required",
    categories: fields.categories,
    matches: fields.matches,
    agentAssessed: fields.agentAssessed,
    reason,
    wikiPr: fields.wikiPr ?? null,
  };
}

function hasIndependentApproval(pullRequest) {
  return (pullRequest.reviews || []).some(
    (review) =>
      review.state === "APPROVED" &&
      review.user &&
      review.user.toLowerCase() !== String(pullRequest.author || "").toLowerCase()
  );
}

export function evaluateWikiSync({ classification, marker, access, wikiPullRequest, sourcePr }) {
  const categories = classification.categories;
  const matches = classification.matches;
  const agentAssessed = classification.impact === "neutral" && marker?.result === "update-required";
  const fields = { categories, matches, agentAssessed, wikiPr: null };

  if (marker?.error) {
    return blocked(fields, `Wiki sync marker is invalid: ${marker.error}.`);
  }

  if (effectiveImpact(classification, marker) === "neutral") {
    const agentReason =
      marker?.result === "no-update-required" && marker.reason ? ` ${marker.reason}` : "";
    return {
      ok: true,
      result: "no-update-required",
      documentationComplete: true,
      impact: "neutral",
      categories,
      matches,
      agentAssessed: false,
      reason: `no-update-required. The diff does not change architecture, integrations, agent capabilities, database or memory design, security or permissions, or development workflows.${agentReason}`,
      wikiPr: null,
    };
  }

  if (marker?.result === "no-update-required") {
    return blocked(
      fields,
      "This diff requires a shared wiki update. A no-update-required result cannot bypass that requirement."
    );
  }

  const parsed = marker?.result === "update-required" ? parseWikiPrUrl(marker.wikiPr) : null;
  if (!parsed) {
    if (marker?.result === "update-required" && marker.wikiPr) {
      return blocked(fields, "wiki_pr is not an ai-development-wiki pull request URL.");
    }
    if (!access || access.level !== "write") {
      return blocked(
        fields,
        "Wiki update required, no linked wiki pull request is present, and wiki write access is unavailable. Documentation sync failed closed."
      );
    }
    return blocked(
      fields,
      "Wiki update required but the pull request body does not link an ai-development-wiki pull request."
    );
  }
  fields.wikiPr = parsed.url;

  if (!access || access.level === "none") {
    return blocked(
      fields,
      "Wiki access is unavailable, so the linked wiki pull request cannot be verified. Documentation sync failed closed."
    );
  }

  if (!wikiPullRequest || wikiPullRequest.unreadable) {
    const status = wikiPullRequest?.status ? ` (HTTP ${wikiPullRequest.status})` : "";
    return blocked(
      fields,
      `Linked wiki pull request could not be read${status}. Documentation sync failed closed.`
    );
  }

  if (wikiPullRequest.repo !== WIKI_REPO) {
    return blocked(fields, "Linked pull request is not in Freedomfarms/ai-development-wiki.");
  }

  if (!wikiBodyReferencesSource(wikiPullRequest.body, sourcePr)) {
    return blocked(
      fields,
      "Linked wiki pull request does not reference this project pull request or its head branch."
    );
  }

  if (wikiPullRequest.reviews == null) {
    return blocked(
      fields,
      "Wiki pull request reviews could not be read. Documentation sync failed closed."
    );
  }

  const approved = hasIndependentApproval(wikiPullRequest);
  const synchronized = wikiPullRequest.merged === true || wikiPullRequest.synchronized === true;
  if (!approved || !synchronized) {
    return blocked(
      fields,
      `Wiki pull request #${wikiPullRequest.number} needs an approving review from someone other than its author and must be merged or otherwise synchronized before documentation is complete.`
    );
  }

  return {
    ok: true,
    result: "synchronized",
    documentationComplete: true,
    impact: "wiki-required",
    categories,
    matches,
    agentAssessed,
    reason: `Wiki pull request #${wikiPullRequest.number} is reviewed and synchronized.`,
    wikiPr: parsed.url,
  };
}

export function accessFromRepoPayload(status, body) {
  if (status !== 200 || !body || typeof body !== "object") {
    return {
      level: "none",
      reason: `GitHub returned ${status} for ${WIKI_REPO}. Wiki access is unavailable.`,
    };
  }
  // `permissions` here is the user or app role, not a fine-grained token's scopes.
  // A contents-read token for an owner still reports `push: true`, so this
  // function never reports write. Pull-request reads are probed separately.
  const permissions = body.permissions || {};
  if (permissions.pull || permissions.push) {
    return {
      level: "read",
      reason: "Token can see the wiki repository. Pull request access is checked separately.",
    };
  }
  return { level: "none", reason: "Token has no pull or push permission on the wiki." };
}

export async function defaultGithub(pathname, token) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "freedom-os-wiki-sync",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 200) };
    }
  }
  return { status: response.status, body };
}

async function loadWikiPullRequest(github, token, parsed, defaultBranch) {
  const prResponse = await github(`/repos/${WIKI_REPO}/pulls/${parsed.number}`, token);
  if (prResponse.status !== 200) {
    return {
      unreadable: true,
      status: prResponse.status,
      url: parsed.url,
      number: parsed.number,
      repo: parsed.repo,
    };
  }
  const pr = prResponse.body;
  const reviewsResponse = await github(
    `/repos/${WIKI_REPO}/pulls/${parsed.number}/reviews?per_page=100`,
    token
  );
  const reviews =
    reviewsResponse.status === 200 && Array.isArray(reviewsResponse.body)
      ? reviewsResponse.body.map((review) => ({
          user: review.user?.login || "",
          state: review.state,
        }))
      : null;

  let synchronized = false;
  if (!pr.merged && pr.head?.sha) {
    const compare = await github(
      `/repos/${WIKI_REPO}/compare/${encodeURIComponent(defaultBranch)}...${pr.head.sha}`,
      token
    );
    if (
      compare.status === 200 &&
      (compare.body?.status === "behind" || compare.body?.status === "identical")
    ) {
      synchronized = true;
    }
  }

  return {
    number: pr.number,
    url: pr.html_url || parsed.url,
    repo: parsed.repo,
    state: pr.state,
    merged: Boolean(pr.merged),
    synchronized,
    author: pr.user?.login || "",
    body: pr.body || "",
    reviews,
  };
}

function summaryMarkdown(record) {
  return [
    "### Shared wiki sync",
    "",
    `- Result: \`${record.result}\``,
    `- Documentation complete: ${record.documentationComplete ? "yes" : "no"}`,
    `- Impact: ${record.impact}`,
    record.categories.length
      ? `- Categories: ${record.categories.join(", ")}`
      : "- Categories: none",
    record.wikiPr ? `- Wiki PR: ${record.wikiPr}` : null,
    "",
    record.reason,
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export async function runCheck({
  changes,
  body = "",
  token = "",
  sourcePr = null,
  github = defaultGithub,
  resultPath = null,
  summaryPath = null,
} = {}) {
  const marker = parseWikiMarker(body);
  const classification = classifyChanges(changes);
  let access = token
    ? { level: "none", reason: "Wiki access was not probed." }
    : {
        level: "none",
        reason: "AI_DEV_WIKI_TOKEN is not set, so wiki write access is unavailable.",
      };
  let wikiPullRequest = null;

  const probe =
    token &&
    effectiveImpact(classification, marker) === "wiki-required" &&
    !marker?.error &&
    marker?.result !== "no-update-required";

  if (probe) {
    try {
      const repoResponse = await github(`/repos/${WIKI_REPO}`, token);
      access = accessFromRepoPayload(repoResponse.status, repoResponse.body);
      if (access.level !== "none") {
        const pullsResponse = await github(`/repos/${WIKI_REPO}/pulls?per_page=1&state=all`, token);
        if (pullsResponse.status === 200) {
          access = {
            level: "read",
            reason: "Token can read wiki pull requests but has not proven it can push.",
          };
        } else {
          access = {
            level: "none",
            reason: `Token cannot read wiki pull requests (HTTP ${pullsResponse.status}). Wiki write access is unavailable.`,
          };
        }
      }
      const parsed = marker?.result === "update-required" ? parseWikiPrUrl(marker.wikiPr) : null;
      if (parsed && access.level !== "none") {
        wikiPullRequest = await loadWikiPullRequest(
          github,
          token,
          parsed,
          repoResponse.body?.default_branch || "main"
        );
      }
    } catch {
      access = {
        level: "none",
        reason:
          "Wiki access failed before the pull request could be verified. Documentation sync failed closed.",
      };
    }
  }

  const record = evaluateWikiSync({ classification, marker, access, wikiPullRequest, sourcePr });
  if (resultPath) {
    fs.writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`);
  }
  if (summaryPath) {
    fs.appendFileSync(summaryPath, summaryMarkdown(record));
  }
  return record;
}

function gitShow(rev, file) {
  try {
    return execFileSync("git", ["show", `${rev}:${file}`], { encoding: "utf8" });
  } catch {
    return null;
  }
}

function readGitChanges(base, head) {
  const text = execFileSync("git", ["diff", "--name-status", `${base}...${head}`], {
    encoding: "utf8",
  });
  return parseNameStatus(text);
}

function annotateDependencyChanges(changes, base, head) {
  return changes.map((change) => {
    if (change.path !== "package.json") return change;
    return {
      ...change,
      dependencyNamesChanged: dependencyNamesChanged(
        gitShow(base, "package.json"),
        gitShow(head, "package.json")
      ),
    };
  });
}

function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

function readSourcePr(event) {
  const repo = process.env.GITHUB_REPOSITORY || null;
  const numberRaw = process.env.PR_NUMBER || event?.pull_request?.number;
  const number = numberRaw ? Number(numberRaw) : null;
  const branch = process.env.SOURCE_BRANCH || event?.pull_request?.head?.ref || null;
  if (!repo && !number && !branch) return null;
  return { repo, number, branch };
}

async function main() {
  const command = process.argv[2];
  if (command === "classify") {
    const base = process.env.BASE_SHA || "origin/main";
    const head = process.env.HEAD_SHA || "HEAD";
    const classification = classifyChanges(
      annotateDependencyChanges(readGitChanges(base, head), base, head)
    );
    process.stdout.write(`${JSON.stringify(classification, null, 2)}\n`);
    return;
  }
  if (command === "check") {
    const event = readEvent();
    const base = process.env.BASE_SHA || event?.pull_request?.base?.sha;
    const head = process.env.HEAD_SHA || event?.pull_request?.head?.sha || "HEAD";
    if (!base) {
      process.stderr.write("BASE_SHA is required (pull request base sha).\n");
      process.exit(2);
    }
    const record = await runCheck({
      changes: annotateDependencyChanges(readGitChanges(base, head), base, head),
      body: process.env.PR_BODY ?? event?.pull_request?.body ?? "",
      token: process.env.AI_DEV_WIKI_TOKEN || "",
      sourcePr: readSourcePr(event),
      resultPath: process.env.WIKI_SYNC_RESULT || path.resolve("wiki-sync-result.json"),
      summaryPath: process.env.GITHUB_STEP_SUMMARY || null,
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    process.exit(record.ok ? 0 : 1);
  }
  process.stderr.write("usage: node scripts/wiki-sync.mjs classify|check\n");
  process.exit(2);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    const record = {
      ok: false,
      result: "blocked",
      documentationComplete: false,
      impact: "wiki-required",
      categories: [],
      matches: [],
      agentAssessed: false,
      reason: "Documentation sync failed closed because the check could not finish.",
      wikiPr: null,
    };
    try {
      fs.writeFileSync(
        process.env.WIKI_SYNC_RESULT || path.resolve("wiki-sync-result.json"),
        `${JSON.stringify(record, null, 2)}\n`
      );
    } catch {
      // The exit status is the fail-closed signal when the result file cannot be written.
    }
    process.stderr.write(`${error instanceof Error ? error.message : "wiki sync check failed"}\n`);
    process.exit(1);
  });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CATEGORY_ORDER,
  RULES,
  accessFromRepoPayload,
  classifyChanges,
  dependencyNamesChanged,
  evaluateWikiSync,
  parseNameStatus,
  parseWikiMarker,
  parseWikiPrUrl,
  runCheck,
  ownerMergeAuthorizes,
  wikiBodyReferencesSource,
  wikiReviewAuthorizes,
} from "../scripts/wiki-sync.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIKI_PR = "https://github.com/Freedomfarms/ai-development-wiki/pull/7";

function marker(result, extra = "") {
  return `<!-- wiki-sync -->\nresult: ${result}\n${extra}<!-- /wiki-sync -->`;
}

function reviewedMerge(overrides = {}) {
  return {
    number: 7,
    url: WIKI_PR,
    repo: "Freedomfarms/ai-development-wiki",
    state: "closed",
    merged: true,
    synchronized: false,
    author: "agent",
    headSha: "abc",
    owner: "Freedomfarms",
    maintainers: [],
    body: "Source: Freedomfarms/Forward-Freedom-Main#400",
    reviews: [{ user: "reviewer", state: "APPROVED", commitId: "abc" }],
    ...overrides,
  };
}

test("every documentation-impact category has a deterministic rule", () => {
  const categories = new Set(RULES.map((rule) => rule.category));
  for (const category of CATEGORY_ORDER) {
    assert.ok(categories.has(category), category);
  }
});

test("an architecture change cannot pass by declaring no-update-required", () => {
  const classification = classifyChanges([{ path: "docs/adr/0099-example.md", status: "A" }]);
  assert.equal(classification.impact, "wiki-required");
  assert.ok(classification.categories.includes("architecture"));

  const result = evaluateWikiSync({
    classification,
    marker: parseWikiMarker(marker("no-update-required", "reason: bug fix only\n")),
    access: { level: "write" },
    wikiPullRequest: reviewedMerge(),
    sourcePr: {
      repo: "Freedomfarms/Forward-Freedom-Main",
      number: 400,
      branch: "cursor/example-baac",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.documentationComplete, false);
  assert.equal(result.result, "blocked");
  assert.match(result.reason, /cannot bypass/);
});

test("a schema change without a wiki pull request is blocked", () => {
  const classification = classifyChanges([{ path: "prisma/schema.prisma", status: "M" }]);
  const result = evaluateWikiSync({
    classification,
    marker: null,
    access: { level: "write" },
    wikiPullRequest: null,
    sourcePr: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not link/);
});

test("documentation-neutral changes pass without wiki edits or wiki access", () => {
  const classification = classifyChanges([
    { path: "src/components/AccountRow.jsx", status: "M" },
    { path: "test/account-removal-summary.test.js", status: "M" },
    { path: "server/plaid/handlers.js", status: "M" },
    { path: "server/chief/memory/facts.js", status: "M" },
    { path: "server/chief/security/rate-limit.js", status: "M" },
  ]);
  assert.equal(classification.impact, "neutral");

  const result = evaluateWikiSync({
    classification,
    marker: null,
    access: { level: "none" },
    wikiPullRequest: null,
    sourcePr: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.result, "no-update-required");
  assert.equal(result.documentationComplete, true);
  assert.equal(result.wikiPr, null);
});

test("adding an integration file or a capability registry edit cannot skip the wiki", () => {
  const added = classifyChanges([{ path: "server/plaid/newBank.js", status: "A" }]);
  assert.deepEqual(added.categories, ["integrations"]);
  const registry = classifyChanges([
    { path: "server/chief/capabilities/registry.js", status: "M" },
  ]);
  assert.ok(registry.categories.includes("agent-capabilities"));
  const grants = classifyChanges([{ path: "server/chief/security/grants.js", status: "M" }]);
  assert.ok(grants.categories.includes("security-permissions"));
  const workflow = classifyChanges([{ path: ".github/workflows/ci.yml", status: "M" }]);
  assert.ok(workflow.categories.includes("workflows-decisions"));

  for (const classification of [added, registry, grants, workflow]) {
    const result = evaluateWikiSync({
      classification,
      marker: parseWikiMarker(marker("no-update-required", "reason: small fix\n")),
      access: { level: "write" },
      wikiPullRequest: null,
      sourcePr: null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.documentationComplete, false);
  }
});

test("a required diff fails closed when wiki write access is unavailable", () => {
  const classification = classifyChanges([
    { path: "prisma/migrations/new/migration.sql", status: "A" },
  ]);
  const missing = evaluateWikiSync({
    classification,
    marker: null,
    access: { level: "none", reason: "AI_DEV_WIKI_TOKEN is not set" },
    wikiPullRequest: null,
    sourcePr: null,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /write access is unavailable/);
  assert.match(missing.reason, /failed closed/);

  const unreadable = evaluateWikiSync({
    classification,
    marker: parseWikiMarker(marker("update-required", `wiki_pr: ${WIKI_PR}\n`)),
    access: { level: "none" },
    wikiPullRequest: null,
    sourcePr: { repo: "Freedomfarms/Forward-Freedom-Main", number: 400 },
  });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.reason, /cannot be verified/);
});

test("documentation stays incomplete until the wiki pull request is approved and synchronized", () => {
  const classification = classifyChanges([{ path: "AGENTS.md", status: "M" }]);
  const markerValue = parseWikiMarker(
    marker("update-required", `wiki_pr: ${WIKI_PR}\nreason: workflow\n`)
  );
  const sourcePr = {
    repo: "Freedomfarms/Forward-Freedom-Main",
    number: 400,
    branch: "cursor/example-baac",
  };
  const access = { level: "read" };

  const open = evaluateWikiSync({
    classification,
    marker: markerValue,
    access,
    wikiPullRequest: reviewedMerge({ merged: false, state: "open" }),
    sourcePr,
  });
  assert.equal(open.documentationComplete, false);

  const selfApproved = evaluateWikiSync({
    classification,
    marker: markerValue,
    access,
    wikiPullRequest: reviewedMerge({
      reviews: [{ user: "agent", state: "APPROVED", commitId: "abc" }],
    }),
    sourcePr,
  });
  assert.equal(selfApproved.ok, false);
  assert.match(selfApproved.reason, /approving review/);

  const unlinked = evaluateWikiSync({
    classification,
    marker: markerValue,
    access,
    wikiPullRequest: reviewedMerge({ body: "unrelated" }),
    sourcePr,
  });
  assert.equal(unlinked.ok, false);
  assert.match(unlinked.reason, /does not reference/);

  const done = evaluateWikiSync({
    classification,
    marker: markerValue,
    access,
    wikiPullRequest: reviewedMerge(),
    sourcePr,
  });
  assert.equal(done.ok, true);
  assert.equal(done.result, "synchronized");
  assert.equal(done.documentationComplete, true);
  assert.equal(done.wikiPr, WIKI_PR);
});

test("a wiki head already on the default branch counts as synchronized after review", () => {
  const result = evaluateWikiSync({
    classification: classifyChanges([{ path: "docs/SECURITY.md", status: "M" }]),
    marker: parseWikiMarker(marker("update-required", `wiki_pr: ${WIKI_PR}\n`)),
    access: { level: "write" },
    wikiPullRequest: reviewedMerge({
      merged: false,
      synchronized: true,
      state: "closed",
      body: "branch cursor/example-baac",
    }),
    sourcePr: {
      repo: "Freedomfarms/Forward-Freedom-Main",
      number: 1,
      branch: "cursor/example-baac",
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.result, "synchronized");
});

test("an agent-marked update on a neutral diff cannot complete without the wiki pull request", () => {
  const result = evaluateWikiSync({
    classification: classifyChanges([{ path: "src/components/AccountRow.jsx", status: "M" }]),
    marker: parseWikiMarker(
      marker("update-required", "reason: behavior change inside a neutral file\n")
    ),
    access: { level: "write" },
    wikiPullRequest: null,
    sourcePr: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.agentAssessed, true);
  assert.match(result.reason, /does not link/);
});

test("dependency additions require a wiki update and version bumps do not", () => {
  assert.equal(
    dependencyNamesChanged(
      JSON.stringify({ dependencies: { pg: "1.0.0" } }),
      JSON.stringify({ dependencies: { pg: "1.0.0", plaid: "2.0.0" } })
    ),
    true
  );
  assert.equal(
    dependencyNamesChanged(
      JSON.stringify({ dependencies: { pg: "1.0.0" } }),
      JSON.stringify({ dependencies: { pg: "1.2.0" } })
    ),
    false
  );
  const added = classifyChanges([
    { path: "package.json", status: "M", dependencyNamesChanged: true },
  ]);
  assert.ok(added.categories.includes("integrations"));
  const bumped = classifyChanges([
    { path: "package.json", status: "M", dependencyNamesChanged: false },
  ]);
  assert.equal(bumped.impact, "neutral");
});

test("name-status renames keep both paths", () => {
  const changes = parseNameStatus(
    "R100\tserver/plaid/old.js\tserver/plaid/new.js\nM\tsrc/App.jsx\n"
  );
  assert.equal(changes[0].previousPath, "server/plaid/old.js");
  const classification = classifyChanges(changes);
  assert.equal(classification.impact, "wiki-required");
});

test("wiki pull request urls from other repositories are rejected", () => {
  assert.equal(parseWikiPrUrl("https://github.com/Freedomfarms/Forward-Freedom-Main/pull/7"), null);
  assert.equal(parseWikiPrUrl(WIKI_PR).number, 7);
  assert.equal(
    wikiBodyReferencesSource("see Freedomfarms/Forward-Freedom-Main#12", {
      repo: "Freedomfarms/Forward-Freedom-Main",
      number: 12,
    }),
    true
  );
});

test("a rejected wiki API fails closed and a neutral diff does not call it", async () => {
  let calls = 0;
  const neutral = await runCheck({
    changes: [{ path: "src/components/AccountRow.jsx", status: "M" }],
    body: "",
    token: "",
    github: async () => {
      calls += 1;
      return { status: 500, body: null };
    },
  });
  assert.equal(calls, 0);
  assert.equal(neutral.result, "no-update-required");

  const blocked = await runCheck({
    changes: [{ path: "vercel.json", status: "M" }],
    body: marker("update-required", `wiki_pr: ${WIKI_PR}\n`),
    token: "present",
    github: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /failed closed/);

  assert.equal(accessFromRepoPayload(404, { message: "Not Found" }).level, "none");
  assert.equal(
    accessFromRepoPayload(200, { permissions: { pull: true, push: false } }).level,
    "read"
  );
  assert.equal(
    accessFromRepoPayload(200, { permissions: { admin: true, push: true, pull: true } }).level,
    "read"
  );
});

test("a contents-read token that cannot list pull requests fails closed", async () => {
  const outcome = await runCheck({
    changes: [{ path: "docs/adr/0099-example.md", status: "A" }],
    body: marker("update-required", `wiki_pr: ${WIKI_PR}\n`),
    token: "present",
    github: async (pathname) => {
      if (pathname === "/repos/Freedomfarms/ai-development-wiki") {
        return {
          status: 200,
          body: { permissions: { admin: true, push: true, pull: true }, default_branch: "main" },
        };
      }
      if (pathname.startsWith("/repos/Freedomfarms/ai-development-wiki/pulls")) {
        return {
          status: 403,
          body: { message: "Resource not accessible by personal access token" },
        };
      }
      throw new Error(`unexpected ${pathname}`);
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.documentationComplete, false);
  assert.match(outcome.reason, /unavailable|failed closed/);
});

test("runCheck records a synchronized wiki pull request", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-sync-"));
  const resultPath = path.join(directory, "result.json");
  const summaryPath = path.join(directory, "summary.md");
  const outcome = await runCheck({
    changes: [{ path: "docs/adr/0099-example.md", status: "A" }],
    body: marker("update-required", `wiki_pr: ${WIKI_PR}\nreason: ADR added.\n`),
    token: "present",
    sourcePr: {
      repo: "Freedomfarms/Forward-Freedom-Main",
      number: 400,
      branch: "cursor/example-baac",
    },
    resultPath,
    summaryPath,
    github: async (pathname) => {
      if (pathname === "/repos/Freedomfarms/ai-development-wiki") {
        return {
          status: 200,
          body: {
            permissions: { push: true, pull: true },
            default_branch: "main",
            owner: { login: "Freedomfarms" },
          },
        };
      }
      if (pathname.startsWith("/repos/Freedomfarms/ai-development-wiki/pulls?")) {
        return { status: 200, body: [] };
      }
      if (pathname === "/repos/Freedomfarms/ai-development-wiki/pulls/7") {
        return {
          status: 200,
          body: {
            number: 7,
            html_url: WIKI_PR,
            state: "closed",
            merged: true,
            user: { login: "agent" },
            body: "Updates Freedomfarms/Forward-Freedom-Main#400",
            head: { sha: "abc" },
          },
        };
      }
      if (pathname.startsWith("/repos/Freedomfarms/ai-development-wiki/pulls/7/reviews")) {
        return {
          status: 200,
          body: [{ user: { login: "reviewer" }, state: "APPROVED", commit_id: "abc" }],
        };
      }
      if (pathname.startsWith("/repos/Freedomfarms/ai-development-wiki/compare/")) {
        return { status: 200, body: { status: "behind" } };
      }
      throw new Error(`unexpected ${pathname}`);
    },
  });
  assert.equal(outcome.result, "synchronized");
  const saved = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  assert.equal(saved.documentationComplete, true);
  assert.match(fs.readFileSync(summaryPath, "utf8"), /no-update-required|synchronized/);
  assert.match(fs.readFileSync(summaryPath, "utf8"), /synchronized/);
});

const sourcePr = {
  repo: "Freedomfarms/Forward-Freedom-Main",
  number: 400,
  branch: "cursor/example-baac",
};

function requiredClassification() {
  return classifyChanges([{ path: "docs/adr/0099-example.md", status: "A" }]);
}

function updateMarker(extra = "") {
  return parseWikiMarker(
    marker("update-required", `wiki_pr: ${WIKI_PR}\nreason: ADR added.\n${extra}`)
  );
}

function ownerMerge(overrides = {}) {
  return reviewedMerge({
    author: "Freedomfarms",
    owner: "Freedomfarms",
    merged: true,
    mergedBy: "Freedomfarms",
    headSha: "abc",
    headOnDefaultBranch: true,
    reviews: [],
    body: "Source: Freedomfarms/Forward-Freedom-Main#400\nMerged by Freedomfarms.",
    ...overrides,
  });
}

test("a merge by the repository owner authorizes the incorporated head", () => {
  const pullRequest = ownerMerge();
  assert.equal(ownerMergeAuthorizes(pullRequest), true);
  const result = evaluateWikiSync({
    classification: requiredClassification(),
    marker: updateMarker("merged by Freedomfarms\n"),
    access: { level: "read" },
    wikiPullRequest: pullRequest,
    sourcePr,
  });
  assert.equal(result.ok, true);
  assert.equal(result.result, "synchronized");
  assert.match(result.reason, /merged by the repository owner/);
  assert.match(result.reason, /abc is on the default branch/);
});

test("an unauthorized merger or a body claim cannot authorize wiki sync", () => {
  const contributor = evaluateWikiSync({
    classification: requiredClassification(),
    marker: updateMarker(),
    access: { level: "read" },
    wikiPullRequest: ownerMerge({ mergedBy: "contributor" }),
    sourcePr,
  });
  assert.equal(contributor.ok, false);
  assert.equal(ownerMergeAuthorizes(ownerMerge({ mergedBy: "contributor" })), false);
  assert.match(contributor.reason, /no verified owner merge/);

  const claimed = evaluateWikiSync({
    classification: requiredClassification(),
    marker: updateMarker("Owner merge authorized by Freedomfarms.\n"),
    access: { level: "read" },
    wikiPullRequest: ownerMerge({
      mergedBy: "",
      body: "Source: Freedomfarms/Forward-Freedom-Main#400\nmerged_by: Freedomfarms",
    }),
    sourcePr,
  });
  assert.equal(claimed.ok, false);
  assert.match(claimed.reason, /no verified owner merge/);

  const selfApproval = wikiReviewAuthorizes({
    author: "Freedomfarms",
    owner: "Freedomfarms",
    headSha: "abc",
    reviews: [{ user: "Freedomfarms", state: "APPROVED", commitId: "abc" }],
  });
  assert.equal(selfApproval.authorized, false);
});

test("owner merge fails when the wiki head SHA is not on the default branch", () => {
  const wrongSha = evaluateWikiSync({
    classification: requiredClassification(),
    marker: updateMarker(),
    access: { level: "read" },
    wikiPullRequest: ownerMerge({ headSha: "def", headOnDefaultBranch: false }),
    sourcePr,
  });
  assert.equal(wrongSha.ok, false);
  assert.equal(wrongSha.documentationComplete, false);
  assert.match(wrongSha.reason, /def/);
  assert.match(wrongSha.reason, /no verified owner merge/);

  const staleReview = evaluateWikiSync({
    classification: requiredClassification(),
    marker: updateMarker(),
    access: { level: "read" },
    wikiPullRequest: ownerMerge({
      merged: false,
      mergedBy: "",
      headSha: "def",
      headOnDefaultBranch: false,
      reviews: [{ user: "reviewer", state: "APPROVED", commitId: "abc" }],
    }),
    sourcePr,
  });
  assert.equal(staleReview.ok, false);
  assert.match(staleReview.reason, /no approving review on def/);
});

test("missing owner, merger, or compare evidence fails closed", async () => {
  const missingMerger = evaluateWikiSync({
    classification: requiredClassification(),
    marker: updateMarker(),
    access: { level: "read" },
    wikiPullRequest: ownerMerge({ mergedBy: "", reviews: null }),
    sourcePr,
  });
  assert.equal(missingMerger.ok, false);
  assert.match(missingMerger.reason, /could not be read|no verified owner merge/);

  function github({ mergedBy, compareStatus, owner }) {
    return async (pathname) => {
      if (pathname === "/repos/Freedomfarms/ai-development-wiki") {
        return {
          status: 200,
          body: {
            permissions: { push: true, pull: true },
            default_branch: "main",
            owner: { login: owner },
          },
        };
      }
      if (pathname.startsWith("/repos/Freedomfarms/ai-development-wiki/pulls?")) {
        return { status: 200, body: [] };
      }
      if (pathname === "/repos/Freedomfarms/ai-development-wiki/pulls/7") {
        return {
          status: 200,
          body: {
            number: 7,
            html_url: WIKI_PR,
            state: "closed",
            merged: true,
            merged_by: mergedBy ? { login: mergedBy } : null,
            user: { login: "Freedomfarms" },
            body: "Updates Freedomfarms/Forward-Freedom-Main#400\nmerged by Freedomfarms",
            head: { sha: "abc" },
          },
        };
      }
      if (pathname.startsWith("/repos/Freedomfarms/ai-development-wiki/pulls/7/reviews")) {
        return { status: 200, body: [] };
      }
      if (pathname === "/repos/Freedomfarms/ai-development-wiki/compare/main...abc") {
        return compareStatus;
      }
      throw new Error(`unexpected ${pathname}`);
    };
  }

  const valid = await runCheck({
    changes: [{ path: "docs/adr/0099-example.md", status: "A" }],
    body: marker("update-required", `wiki_pr: ${WIKI_PR}\nreason: ADR added.\n`),
    token: "present",
    sourcePr,
    github: github({
      mergedBy: "Freedomfarms",
      owner: "Freedomfarms",
      compareStatus: { status: 200, body: { status: "behind" } },
    }),
  });
  assert.equal(valid.ok, true);
  assert.match(valid.reason, /merged by the repository owner/);

  const noMerger = await runCheck({
    changes: [{ path: "docs/adr/0099-example.md", status: "A" }],
    body: marker("update-required", `wiki_pr: ${WIKI_PR}\nreason: ADR added.\n`),
    token: "present",
    sourcePr,
    github: github({
      mergedBy: "",
      owner: "Freedomfarms",
      compareStatus: { status: 200, body: { status: "behind" } },
    }),
  });
  assert.equal(noMerger.ok, false);
  assert.match(noMerger.reason, /no verified owner merge/);

  const compareDown = await runCheck({
    changes: [{ path: "docs/adr/0099-example.md", status: "A" }],
    body: marker("update-required", `wiki_pr: ${WIKI_PR}\nreason: ADR added.\n`),
    token: "present",
    sourcePr,
    github: github({
      mergedBy: "Freedomfarms",
      owner: "Freedomfarms",
      compareStatus: { status: 500, body: null },
    }),
  });
  assert.equal(compareDown.ok, false);
  assert.match(compareDown.reason, /no verified owner merge/);
});

test("a missing or invalid wiki token fails closed and a linked wiki pull request still has to match", async () => {
  const missingToken = await runCheck({
    changes: [{ path: "docs/adr/0099-example.md", status: "A" }],
    body: marker("update-required", `wiki_pr: ${WIKI_PR}\n`),
    token: "",
    sourcePr,
    github: async () => {
      throw new Error("token must not be used");
    },
  });
  assert.equal(missingToken.ok, false);
  assert.match(missingToken.reason, /cannot be verified|failed closed/);

  const invalidToken = await runCheck({
    changes: [{ path: "docs/adr/0099-example.md", status: "A" }],
    body: marker("update-required", `wiki_pr: ${WIKI_PR}\n`),
    token: "invalid",
    sourcePr,
    github: async (pathname) => {
      if (pathname === "/repos/Freedomfarms/ai-development-wiki") {
        return { status: 401, body: { message: "Bad credentials" } };
      }
      throw new Error(`unexpected ${pathname}`);
    },
  });
  assert.equal(invalidToken.ok, false);
  assert.match(invalidToken.reason, /failed closed|unavailable/);

  const linked = evaluateWikiSync({
    classification: requiredClassification(),
    marker: updateMarker(),
    access: { level: "read" },
    wikiPullRequest: reviewedMerge(),
    sourcePr,
  });
  assert.equal(linked.ok, true);
  assert.equal(linked.wikiPr, WIKI_PR);

  const wrongRepo = evaluateWikiSync({
    classification: requiredClassification(),
    marker: updateMarker(),
    access: { level: "read" },
    wikiPullRequest: reviewedMerge({ repo: "Freedomfarms/Forward-Freedom-Main" }),
    sourcePr,
  });
  assert.equal(wrongRepo.ok, false);
  assert.match(wrongRepo.reason, /not in Freedomfarms\/ai-development-wiki/);
});

test("ci runs the wiki sync check and cannot continue on error", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /wiki-sync:/);
  assert.match(workflow, /node scripts\/wiki-sync\.mjs check/);
  assert.match(workflow, /secrets\.AI_DEV_WIKI_TOKEN/);
  assert.doesNotMatch(workflow, /WIKI_SYNC_MAINTAINERS/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /^\s*pull_request_target:/m);
  assert.doesNotMatch(workflow, /continue-on-error/);

  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /scripts\/wiki-sync\.mjs classify/);
  assert.match(agents, /no-update-required/);
  assert.match(agents, /failed closed|fails closed/);
  assert.match(agents, /repository owner/);
  assert.match(agents, /not authorization/);
  assert.match(agents, /wiki default/);

  const rule = fs.readFileSync(path.join(root, ".cursor/rules/shared-wiki.mdc"), "utf8");
  assert.match(rule, /wiki-sync\.mjs/);
  assert.match(rule, /fails closed|failed closed/);
});

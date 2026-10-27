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
  wikiBodyReferencesSource,
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
    body: "Source: Freedomfarms/Forward-Freedom-Main#400",
    reviews: [{ user: "reviewer", state: "APPROVED" }],
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
    wikiPullRequest: reviewedMerge({ reviews: [{ user: "agent", state: "APPROVED" }] }),
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
          body: { permissions: { push: true, pull: true }, default_branch: "main" },
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
        return { status: 200, body: [{ user: { login: "reviewer" }, state: "APPROVED" }] };
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

test("ci runs the wiki sync check and cannot continue on error", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /wiki-sync:/);
  assert.match(workflow, /node scripts\/wiki-sync\.mjs check/);
  assert.match(workflow, /secrets\.AI_DEV_WIKI_TOKEN/);
  assert.doesNotMatch(workflow, /continue-on-error/);

  const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /scripts\/wiki-sync\.mjs classify/);
  assert.match(agents, /no-update-required/);
  assert.match(agents, /failed closed|fails closed/);

  const rule = fs.readFileSync(path.join(root, ".cursor/rules/shared-wiki.mdc"), "utf8");
  assert.match(rule, /wiki-sync\.mjs/);
  assert.match(rule, /fails closed|failed closed/);
});

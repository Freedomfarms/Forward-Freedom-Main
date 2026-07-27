import test from "node:test";
import assert from "node:assert/strict";

import {
  FINANCE_AGGREGATES_CACHE_TTL_MS,
  resetFinanceAggregatesCacheForTesting,
  summarizeAggregatesForCeo,
  unavailableServerSummary,
} from "../server/brain/worldModel.js";
import { renderApplicationState, CEO_ENABLED_TOOLS } from "../server/brain/ceoContextAssembler.js";
import { PLATFORM_CAPABILITIES } from "../server/capabilities/registry.js";
import {
  CEO_REASONING_DEPENDENCIES,
  CEO_REASONING_MIGRATION_STATUS,
} from "../server/brain/ceoReasoningDependencies.js";
import { BRAIN_SYSTEM_PROMPT } from "../server/brain/prompts.js";

test("unavailable server summaries are explicit status objects", () => {
  assert.deepEqual(unavailableServerSummary("trueCash"), {
    domain: "trueCash",
    status: "unavailable_server_summary",
  });
});

test("summarizeAggregatesForCeo never includes merchant or account identifiers", () => {
  const summary = summarizeAggregatesForCeo({
    months: ["2026-01", "2026-02"],
    transactionCount: 12,
    accountBalancesByType: [{ accountType: "Checking", totalBalance: 100, accountCount: 1 }],
    categoryDeltas: [
      {
        category: "Dining",
        latestMonth: "2026-02",
        latestTotal: -50,
        momChangePct: 10,
        vsThreeMonthAvgPct: 20,
      },
    ],
    merchants: ["Secret Cafe"],
    accountNames: ["My Chase ****1234"],
  });

  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /Secret Cafe|Chase|\*\*\*\*?1234|merchants|accountNames/i);
  assert.equal(summary.transactionCount, 12);
  assert.equal(summary.accountBalancesByType[0].accountType, "Checking");
  assert.equal(summary.notableCategoryDeltas[0].category, "Dining");
});

test("APPLICATION STATE marks client-only domains unavailable_server_summary", () => {
  const rendered = renderApplicationState({
    financial: {
      lightHealth: { status: "available", accountCount: 2, balancesByType: [] },
      aggregates: { status: "available", cache: { hit: true }, summary: { transactionCount: 0 } },
      budgetStatusVsActual: { status: "unavailable_server_summary" },
      trueCash: { status: "unavailable_server_summary" },
      forecast: { status: "unavailable_server_summary" },
      operationsBoard: { status: "unavailable_server_summary" },
    },
    workspace: { status: "available", hasSnapshot: false },
    connectedServices: { plaid: { itemCount: 0, connectedCount: 0 } },
  });

  assert.match(rendered, /"trueCash"[\s\S]*"unavailable_server_summary"/);
  assert.match(rendered, /"forecast"[\s\S]*"unavailable_server_summary"/);
  assert.match(rendered, /"operationsBoard"/);
  assert.match(rendered, /"budgetStatusVsActual"/);
  assert.match(rendered, /lightHealth/);
  assert.equal(typeof FINANCE_AGGREGATES_CACHE_TTL_MS, "number");
  resetFinanceAggregatesCacheForTesting();
});

test("capability registry does not advertise imaginary finance get_* tools", () => {
  const finance = PLATFORM_CAPABILITIES.finance_aggregates;
  assert.equal(finance.status, "available");
  assert.deepEqual([...finance.tools], []);
  assert.doesNotMatch(
    finance.description,
    /get_accounts|get_budget_status|get_transactions_summary/
  );

  const digest = PLATFORM_CAPABILITIES.daily_digest;
  assert.deepEqual([...digest.tools], ["update_digest"]);

  const research = PLATFORM_CAPABILITIES.web_research;
  assert.deepEqual([...research.tools], ["web_search"]);
});

test("CEO enabled tools match real Brain tool belt names only", () => {
  assert.ok(CEO_ENABLED_TOOLS.includes("web_search"));
  assert.ok(CEO_ENABLED_TOOLS.includes("create_agent"));
  assert.ok(CEO_ENABLED_TOOLS.includes("update_digest"));
  assert.ok(!CEO_ENABLED_TOOLS.includes("get_accounts"));
  assert.ok(!CEO_ENABLED_TOOLS.includes("get_budget_status"));
});

test("ceoReasoning migration inventory is documented and non-authoritative", () => {
  assert.equal(CEO_REASONING_MIGRATION_STATUS.judgmentOwner, "llm_plus_world_model");
  assert.equal(CEO_REASONING_MIGRATION_STATUS.decisionShaping, false);
  assert.equal(CEO_REASONING_MIGRATION_STATUS.deletionCandidate, true);
  assert.equal(CEO_REASONING_MIGRATION_STATUS.doNotExpand, true);
  assert.ok(CEO_REASONING_DEPENDENCIES.length >= 5);
  assert.ok(
    CEO_REASONING_DEPENDENCIES.some((d) => d.file.includes("ceoContextAssembler"))
  );
});

test("Brain prompt points at APPLICATION STATE world model and inferred mission metadata", () => {
  assert.match(BRAIN_SYSTEM_PROMPT, /APPLICATION STATE/);
  assert.match(BRAIN_SYSTEM_PROMPT, /unavailable_server_summary/);
  assert.match(BRAIN_SYSTEM_PROMPT, /inferred metadata only/i);
  assert.match(BRAIN_SYSTEM_PROMPT, /ENABLED TOOLS/);
});

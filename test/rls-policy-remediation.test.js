import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const remediationSql = readFileSync(
  new URL(
    "../prisma/migrations/20260719011500_user_isolation_policy_remediation/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const prismaSchema = readFileSync(
  new URL("../prisma/schema.prisma", import.meta.url),
  "utf8"
);

const expectedPolicyColumns = {
  User: "id",
  PlaidItem: "userId",
  Account: "userId",
  Transaction: "userId",
  PlanYear: "userId",
  BudgetRow: "userId",
  IncomeStream: "userId",
  Subscription: "userId",
  MerchantCategoryRule: "userId",
  MetricSnapshot: "userId",
  LegalConsentEvent: "userId",
  WorkspaceSnapshot: "userId",
  CeoAgentConfig: "userId",
  AgentConfig: "userId",
  AgentRun: "userId",
  AgentChatMessage: "userId",
  Notification: "userId",
};

function withoutComments(sql) {
  return sql.replace(/--.*$/gm, "");
}

function userScopedModels(schema) {
  return [...schema.matchAll(/^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm)]
    .filter((match) => match[1] === "User" || /^\s+userId\s+String\b/m.test(match[2]))
    .map((match) => match[1])
    .sort();
}

const expectedTables = Object.keys(expectedPolicyColumns).sort();

// User-scoped models added AFTER the remediation migration shipped. Each one
// must enable+force RLS in its own migration instead (asserted below).
const laterRlsModels = {
  CeoDocument: "20260720220000_ceo_documents_and_onboarding_summary",
};

test("remediation inventory is exactly every user-scoped model", () => {
  assert.equal(expectedTables.length, 17);
  assert.deepEqual(
    [...expectedTables, ...Object.keys(laterRlsModels)].sort(),
    userScopedModels(prismaSchema)
  );
});

test("models added after the remediation enable and force RLS in their own migration", () => {
  for (const [model, migration] of Object.entries(laterRlsModels)) {
    const sql = withoutComments(
      readFileSync(
        new URL(`../prisma/migrations/${migration}/migration.sql`, import.meta.url),
        "utf8"
      )
    );
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "${model}" ENABLE ROW LEVEL SECURITY;`),
      `${model} must enable RLS in ${migration}`
    );
    assert.match(
      sql,
      new RegExp(`ALTER TABLE "${model}" FORCE ROW LEVEL SECURITY;`),
      `${model} must force RLS in ${migration}`
    );
    assert.match(
      sql,
      new RegExp(`CREATE POLICY "user_isolation" ON "${model}"`),
      `${model} must create the user_isolation policy in ${migration}`
    );
  }
});

test("remediation atomically enables and forces RLS on every target table", () => {
  const executableSql = withoutComments(remediationSql);
  const enabledTables = [
    ...executableSql.matchAll(
      /ALTER TABLE public\."([^"]+)" ENABLE ROW LEVEL SECURITY;/g
    ),
  ].map((match) => match[1]);
  const forcedTables = [
    ...executableSql.matchAll(
      /ALTER TABLE public\."([^"]+)" FORCE ROW LEVEL SECURITY;/g
    ),
  ].map((match) => match[1]);

  assert.match(executableSql.trim(), /^BEGIN;/);
  assert.match(executableSql.trim(), /COMMIT;$/);
  assert.equal(executableSql.match(/\bALTER TABLE\b/gi)?.length, 34);
  assert.deepEqual(enabledTables.sort(), expectedTables);
  assert.deepEqual(forcedTables.sort(), expectedTables);
});

test("remediation drops every existing policy on exactly the target tables", () => {
  const executableSql = withoutComments(remediationSql);
  const cleanupBlock = executableSql.match(
    /DO \$policy_cleanup\$([\s\S]*?)\$policy_cleanup\$;/
  )?.[1];

  assert.ok(cleanupBlock, "catalog-driven policy cleanup block is required");
  const inventory = cleanupBlock.match(
    /FROM pg_policies\s+WHERE schemaname = 'public'\s+AND tablename IN \(([\s\S]*?)\)\s+LOOP/
  )?.[1];
  assert.ok(inventory, "cleanup must be restricted to public and an explicit inventory");

  const cleanupTables = [
    ...inventory.matchAll(/'([^']+)'/g),
  ].map((match) => match[1]);
  assert.deepEqual(cleanupTables.sort(), expectedTables);
  assert.match(
    cleanupBlock,
    /EXECUTE format\(\s*'DROP POLICY %I ON %I\.%I',\s*policy_record\.policyname,\s*policy_record\.schemaname,\s*policy_record\.tablename\s*\);/
  );
  assert.doesNotMatch(cleanupBlock, /policyname\s*(?:=|IN\b)/i);
  assert.equal(executableSql.match(/\bDROP POLICY\b/gi)?.length, 1);
});

test("remediation creates one exact user_isolation policy per target table", () => {
  const executableSql = withoutComments(remediationSql);
  const policyBlocks = [
    ...executableSql.matchAll(
      /CREATE POLICY "user_isolation" ON public\."([^"]+)"\s+FOR ALL\s+USING \("([^"]+)" = current_setting\('app\.current_user_id', true\)\)\s+WITH CHECK \("\2" = current_setting\('app\.current_user_id', true\)\);/g
    ),
  ];

  assert.equal(policyBlocks.length, expectedTables.length);
  assert.deepEqual(
    Object.fromEntries(policyBlocks.map((match) => [match[1], match[2]])),
    expectedPolicyColumns
  );
  assert.equal(executableSql.match(/\bCREATE POLICY\b/gi)?.length, expectedTables.length);
  assert.doesNotMatch(executableSql, /\bALTER POLICY\b/i);
});

test("remediation cannot weaken RLS or introduce an escape path", () => {
  const executableSql = withoutComments(remediationSql);

  assert.doesNotMatch(
    executableSql,
    /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b|\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b|\bBYPASSRLS\b|\bSECURITY\s+DEFINER\b/i
  );
  assert.doesNotMatch(executableSql, /\b(?:GRANT|REVOKE)\b/i);
  assert.doesNotMatch(
    executableSql,
    /\b(?:CREATE|ALTER|DROP|REASSIGN)\s+ROLE\b|\b(?:SET|RESET)\s+ROLE\b|\bSET\s+SESSION\s+AUTHORIZATION\b|\bOWNER\s+TO\b/i
  );
});

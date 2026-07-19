import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const originalSql = readFileSync(
  new URL(
    "../prisma/migrations/20260718200000_freedom_os_row_level_security/migration.sql",
    import.meta.url
  ),
  "utf8"
);
const remediationSql = readFileSync(
  new URL(
    "../prisma/migrations/20260719010000_runtime_role_grant_remediation/migration.sql",
    import.meta.url
  ),
  "utf8"
);

function withoutComments(sql) {
  return sql.replace(/--.*$/gm, "");
}

function roleBlock(sql, role) {
  const match = withoutComments(sql).match(
    new RegExp(
      `IF EXISTS \\(SELECT 1 FROM pg_roles WHERE rolname = '${role}'\\) THEN([\\s\\S]*?)ELSE`
    )
  );
  assert.ok(match, `${role} grants must be conditional for local and shadow databases`);
  return match[1];
}

function grantStatements(sql, role) {
  return (
    roleBlock(sql, role)
      .match(/(?:GRANT|ALTER DEFAULT PRIVILEGES)[\s\S]*?;/g)
      ?.map((statement) => statement.replace(/\s+/g, " ").trim()) || []
  );
}

for (const role of ["freedom_app", "freedom_service"]) {
  test(`remediation restores the original least-privilege grants for ${role}`, () => {
    assert.deepEqual(grantStatements(remediationSql, role), grantStatements(originalSql, role));
  });
}

test("remediation does not create roles, memberships, or elevated privileges", () => {
  const executableSql = withoutComments(remediationSql);

  assert.doesNotMatch(executableSql, /\b(?:CREATE|ALTER)\s+ROLE\b/i);
  assert.doesNotMatch(
    executableSql,
    /\bGRANT\s+freedom_(?:app|service)\s+TO\b|\bGRANT\s+(?:CREATE|TRUNCATE|REFERENCES|TRIGGER)\b/i
  );
});

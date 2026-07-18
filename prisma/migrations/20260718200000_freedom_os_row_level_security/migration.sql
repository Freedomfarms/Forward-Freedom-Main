-- Freedom OS Phase 3: true Postgres row-level security.
--
-- Every user-scoped table gets ENABLE + FORCE ROW LEVEL SECURITY and one
-- FOR ALL policy comparing the row's "userId" ("id" on "User") against the
-- transaction-local setting `app.current_user_id`, which is bound by
-- withUserContext() in server/db/prisma.js as the first statement of every
-- user-scoped transaction.
--
-- FORCE matters: it applies policies even to the table OWNER, closing the
-- bypass that exists today where the app connects as the owning role.
-- current_setting(..., true) returns NULL when the setting is absent, so a
-- query issued without a user context matches zero rows — fail closed, not
-- an error that could leak data.
--
-- Grants for the two runtime roles are applied conditionally: freedom_app
-- (RLS-subject app role) and freedom_service (BYPASSRLS, webhook/cron/admin
-- only) are created MANUALLY (passwords never live in the repo — see
-- docs/RLS_ROLLOUT.md) and must exist before this migration deploys to an
-- environment that will use them. On databases without the roles (local dev,
-- test databases, shadow databases) the grants are skipped with a warning so
-- the migration still applies cleanly.

-- ── Enable + force RLS on every user-scoped table ────────────────────────────

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;

ALTER TABLE "PlaidItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlaidItem" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Account" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Transaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Transaction" FORCE ROW LEVEL SECURITY;

ALTER TABLE "PlanYear" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlanYear" FORCE ROW LEVEL SECURITY;

ALTER TABLE "BudgetRow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BudgetRow" FORCE ROW LEVEL SECURITY;

ALTER TABLE "IncomeStream" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IncomeStream" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subscription" FORCE ROW LEVEL SECURITY;

ALTER TABLE "MerchantCategoryRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MerchantCategoryRule" FORCE ROW LEVEL SECURITY;

ALTER TABLE "MetricSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetricSnapshot" FORCE ROW LEVEL SECURITY;

ALTER TABLE "LegalConsentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegalConsentEvent" FORCE ROW LEVEL SECURITY;

ALTER TABLE "WorkspaceSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceSnapshot" FORCE ROW LEVEL SECURITY;

ALTER TABLE "CeoAgentConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CeoAgentConfig" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AgentConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentConfig" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AgentRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRun" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AgentChatMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentChatMessage" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;

-- ── One FOR ALL policy per table ─────────────────────────────────────────────
-- "User" is keyed by "id"; every other table by "userId".

CREATE POLICY "user_isolation" ON "User"
  FOR ALL
  USING ("id" = current_setting('app.current_user_id', true))
  WITH CHECK ("id" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "PlaidItem"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "Account"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "Transaction"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "PlanYear"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "BudgetRow"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "IncomeStream"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "Subscription"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "MerchantCategoryRule"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "MetricSnapshot"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "LegalConsentEvent"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "WorkspaceSnapshot"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "CeoAgentConfig"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "AgentConfig"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "AgentRun"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "AgentChatMessage"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON "Notification"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

-- ── Grants for the runtime roles ─────────────────────────────────────────────
-- freedom_app: the app's connection role after rollout — full DML, subject to
-- the policies above (no BYPASSRLS, not the table owner).
-- freedom_service: BYPASSRLS role for the webhook/cron/admin service client.
-- ALTER DEFAULT PRIVILEGES makes tables/sequences created by FUTURE migrations
-- (which run as the owner role via DIRECT_URL) inherit the same grants.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_app') THEN
    GRANT USAGE ON SCHEMA public TO freedom_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO freedom_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO freedom_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO freedom_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO freedom_app;
  ELSE
    RAISE WARNING 'Role freedom_app does not exist; grants skipped. Create it (docs/RLS_ROLLOUT.md) and re-run the grants before pointing DATABASE_URL at it.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freedom_service') THEN
    GRANT USAGE ON SCHEMA public TO freedom_service;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO freedom_service;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO freedom_service;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO freedom_service;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO freedom_service;
  ELSE
    RAISE WARNING 'Role freedom_service does not exist; grants skipped. Create it (docs/RLS_ROLLOUT.md) and re-run the grants before setting SERVICE_DATABASE_URL.';
  END IF;
END
$$;

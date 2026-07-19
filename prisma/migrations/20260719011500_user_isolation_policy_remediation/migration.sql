-- Fully reconcile RLS state for every user-scoped table.
--
-- Prisma does not revisit an already-applied migration, so policy state that
-- diverged after the original RLS rollout must be reconciled by a later
-- migration. This transaction restores ENABLE + FORCE, removes every policy
-- regardless of its name or permissive/restrictive mode, and recreates the
-- sole intended policy.

-- "User" is keyed by "id"; every other user-scoped table by "userId".

BEGIN;

-- Restore the required RLS flags even if production state has drifted.

ALTER TABLE public."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."User" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."PlaidItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PlaidItem" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."Account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Account" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."Transaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Transaction" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."PlanYear" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PlanYear" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."BudgetRow" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."BudgetRow" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."IncomeStream" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."IncomeStream" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."Subscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Subscription" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."MerchantCategoryRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MerchantCategoryRule" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."MetricSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."MetricSnapshot" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."LegalConsentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."LegalConsentEvent" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."WorkspaceSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."WorkspaceSnapshot" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."CeoAgentConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CeoAgentConfig" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."AgentConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AgentConfig" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."AgentRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AgentRun" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."AgentChatMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AgentChatMessage" FORCE ROW LEVEL SECURITY;

ALTER TABLE public."Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Notification" FORCE ROW LEVEL SECURITY;

-- Remove arbitrary policy drift. Identifiers come from the catalog and are
-- quoted with format(%I), including unexpected policy names.

DO $policy_cleanup$
DECLARE
  policy_record record;
BEGIN
  FOR policy_record IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'User',
        'PlaidItem',
        'Account',
        'Transaction',
        'PlanYear',
        'BudgetRow',
        'IncomeStream',
        'Subscription',
        'MerchantCategoryRule',
        'MetricSnapshot',
        'LegalConsentEvent',
        'WorkspaceSnapshot',
        'CeoAgentConfig',
        'AgentConfig',
        'AgentRun',
        'AgentChatMessage',
        'Notification'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  END LOOP;
END
$policy_cleanup$;

-- Recreate exactly one intended policy per table.

CREATE POLICY "user_isolation" ON public."User"
  FOR ALL
  USING ("id" = current_setting('app.current_user_id', true))
  WITH CHECK ("id" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."PlaidItem"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."Account"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."Transaction"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."PlanYear"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."BudgetRow"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."IncomeStream"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."Subscription"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."MerchantCategoryRule"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."MetricSnapshot"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."LegalConsentEvent"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."WorkspaceSnapshot"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."CeoAgentConfig"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."AgentConfig"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."AgentRun"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."AgentChatMessage"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

CREATE POLICY "user_isolation" ON public."Notification"
  FOR ALL
  USING ("userId" = current_setting('app.current_user_id', true))
  WITH CHECK ("userId" = current_setting('app.current_user_id', true));

COMMIT;

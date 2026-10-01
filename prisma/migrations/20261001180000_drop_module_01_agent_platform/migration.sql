-- Retire the Module 01 / CEO agent platform after the application code
-- that used these objects has already been removed.
--
-- DROP TABLE ... CASCADE removes each table's RLS policies, grants, indexes,
-- and inbound foreign keys. It does not drop other tables. AgentRun references
-- AgentConversation, so AgentConversation is dropped with CASCADE before
-- AgentRun. User.timezone and User.isAdmin are not touched.
-- Historical migration folders that created these objects stay in place.

DROP TABLE IF EXISTS "AgentChatMessage" CASCADE;
DROP TABLE IF EXISTS "AgentConversation" CASCADE;
DROP TABLE IF EXISTS "AgentRun" CASCADE;
DROP TABLE IF EXISTS "Notification" CASCADE;
DROP TABLE IF EXISTS "BrainJob" CASCADE;
DROP TABLE IF EXISTS "Plan" CASCADE;
DROP TABLE IF EXISTS "CeoDocument" CASCADE;
DROP TABLE IF EXISTS "AgentConfig" CASCADE;
DROP TABLE IF EXISTS "CeoAgentConfig" CASCADE;

DROP TYPE IF EXISTS "CeoPersonalityPreset";
DROP TYPE IF EXISTS "AgentPermissionLevel";
DROP TYPE IF EXISTS "AgentStatus";
DROP TYPE IF EXISTS "AgentRunStatus";
DROP TYPE IF EXISTS "AgentChatRole";
DROP TYPE IF EXISTS "NotificationChannel";
DROP TYPE IF EXISTS "BrainJobStatus";
DROP TYPE IF EXISTS "PlanStatus";

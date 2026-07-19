-- Re-apply runtime privileges after the RLS rollout.
--
-- The original RLS migration conditionally skipped these grants when the
-- manually managed runtime roles did not exist yet. Prisma records a skipped
-- grant block as part of the successfully applied migration, so it is never
-- revisited after the roles are created. This later migration repairs that
-- deployment order while remaining safe for local and shadow databases where
-- the roles intentionally do not exist.
--
-- GRANT and ALTER DEFAULT PRIVILEGES are idempotent. Keep the app role subject
-- to RLS and the service role's BYPASSRLS lifecycle externally managed; this
-- migration grants only the same schema, DML, and sequence access as the
-- original RLS migration.

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
    RAISE WARNING 'Role freedom_app does not exist; runtime grant remediation skipped for this database.';
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
    RAISE WARNING 'Role freedom_service does not exist; runtime grant remediation skipped for this database.';
  END IF;
END
$$;

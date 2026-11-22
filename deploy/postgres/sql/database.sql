-- Per-database setup (idempotent). Run as superuser while connected to the target database.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I OWNER TO eve_owner', current_database());
END
$$;

ALTER SCHEMA public OWNER TO eve_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO eve_app;

-- pgvector is not a trusted extension, so the non-superuser owner cannot create it.
-- Create both here; migration 0001 (IF NOT EXISTS) documents the requirement.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS vector;

-- Tables later created by eve_owner (migrations) are usable by eve_app for DML only.
-- Append-only tables (audit) revoke UPDATE/DELETE in their own migration.
ALTER DEFAULT PRIVILEGES FOR ROLE eve_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eve_app;
ALTER DEFAULT PRIVILEGES FOR ROLE eve_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO eve_app;

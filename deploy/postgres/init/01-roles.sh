#!/bin/sh
# Runs once, on first start of an empty data directory (postgres docker-entrypoint-initdb.d).
# eve_owner owns the schema and runs migrations. eve_app is the runtime role: data access only,
# so later migrations can deny it UPDATE/DELETE on append-only tables such as the audit log.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$EVE_OWNER_PASSWORD" -v app_pw="$EVE_APP_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE eve_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE eve_app LOGIN PASSWORD :'app_pw';

ALTER DATABASE :"db" OWNER TO eve_owner;
ALTER SCHEMA public OWNER TO eve_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO eve_app;

-- pgvector is not a trusted extension, so the non-superuser owner cannot create it. Create both
-- here as superuser; migration 0001 (IF NOT EXISTS) is then a no-op that documents the requirement.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS vector;

-- Objects later created by eve_owner (migrations) are usable by eve_app for DML only.
ALTER DEFAULT PRIVILEGES FOR ROLE eve_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eve_app;
ALTER DEFAULT PRIVILEGES FOR ROLE eve_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO eve_app;
SQL

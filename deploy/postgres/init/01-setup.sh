#!/bin/sh
# Runs once, on first start of an empty data directory (docker-entrypoint-initdb.d).
set -eu

run() { psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"; }

run -f /eve-sql/roles.sql
run -v owner_pw="$EVE_OWNER_PASSWORD" -v app_pw="$EVE_APP_PASSWORD" <<'SQL'
ALTER ROLE eve_owner PASSWORD :'owner_pw';
ALTER ROLE eve_app PASSWORD :'app_pw';
SQL
run -f /eve-sql/database.sql

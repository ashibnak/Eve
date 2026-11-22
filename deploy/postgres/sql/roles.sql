-- Cluster-level roles (idempotent). Passwords are set separately by the caller.
-- eve_owner owns the schema and runs migrations; eve_app is the least-privilege runtime role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eve_owner') THEN
    CREATE ROLE eve_owner LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eve_app') THEN
    CREATE ROLE eve_app LOGIN;
  END IF;
END
$$;

-- Lets migrations (run as eve_owner) create objects owned by eve_app, e.g. the pg-boss schema.
GRANT eve_app TO eve_owner;

-- pg-boss manages its own tables inside this schema (createSchema: false, migrate: true).
-- Owned by the app role so the runtime never needs CREATE rights on the database.
CREATE SCHEMA pgboss AUTHORIZATION eve_app;

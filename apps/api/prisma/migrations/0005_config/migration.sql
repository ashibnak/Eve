-- Customer settings in the database (ADR-012). company_id NULL = customer-wide value.
-- Each key's value schema is registered in code; history lives in the audit log.
CREATE TABLE config_setting (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text        NOT NULL,
  company_id uuid        REFERENCES core_company (id),
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT config_setting_key_company_uq UNIQUE NULLS NOT DISTINCT (key, company_id)
);

-- Minimal platform company registry: the unit of access scope and jurisdiction.
-- org_company (S5) extends it under the same id with names, unit levels and legal fields.
CREATE TABLE core_company (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text        NOT NULL UNIQUE CHECK (code <> '' AND length(code) <= 32),
  jurisdiction_code text        NOT NULL CHECK (jurisdiction_code ~ '^[a-z]{2}$'),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Prisma's migration bookkeeping is for the owner only.
REVOKE ALL ON TABLE _prisma_migrations FROM eve_app;

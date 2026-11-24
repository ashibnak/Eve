-- File imports (ADR-011): upload -> map -> validate -> preview -> commit, as a state machine.
CREATE TABLE connectors_import (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  target              text        NOT NULL,
  source_name         text        NOT NULL CHECK (source_name <> '' AND length(source_name) <= 100),
  company_id          uuid        NOT NULL REFERENCES core_company (id),
  effective_date      date        NOT NULL,
  status              text        NOT NULL CHECK (status IN (
                        'uploaded', 'mapped', 'validated', 'previewed',
                        'awaiting_approval', 'committed', 'discarded')),
  file_name           text        NOT NULL,
  file_format         text        NOT NULL CHECK (file_format IN ('xlsx', 'csv')),
  file_size           integer     NOT NULL CHECK (file_size >= 0),
  -- SHA-256 of the uploaded file: the evidence. file_ref is cleared when the file is purged.
  file_sha256         char(64)    NOT NULL,
  file_ref            char(64),
  -- [{name, headers, rowCount}]
  sheets              jsonb       NOT NULL,
  mapping             jsonb,
  counts              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  findings            jsonb,
  diff                jsonb,
  approval_request_id uuid        REFERENCES approvals_request (id),
  created_by          uuid        NOT NULL REFERENCES auth_user (id),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  committed_at        timestamptz,
  purged_at           timestamptz
);
CREATE INDEX connectors_import_company_idx ON connectors_import (company_id, created_at);
CREATE INDEX connectors_import_retention_idx ON connectors_import (updated_at)
  WHERE status NOT IN ('committed', 'awaiting_approval') AND purged_at IS NULL;

-- Staged rows: working data, not audited; deleted when an import is discarded or abandoned
-- (retention: 30 days, product-owner decision S3).
CREATE TABLE connectors_import_row (
  import_id  uuid    NOT NULL REFERENCES connectors_import (id),
  sheet      text    NOT NULL,
  row_number integer NOT NULL,
  entity     text    NOT NULL,
  key        text,
  values     jsonb   NOT NULL,
  errors     jsonb   NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (import_id, sheet, row_number)
);

-- Column mappings saved per target, company and source, so the next import is pre-mapped.
CREATE TABLE connectors_mapping (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  target      text        NOT NULL,
  company_id  uuid        NOT NULL REFERENCES core_company (id),
  source_name text        NOT NULL,
  mapping     jsonb       NOT NULL,
  updated_by  uuid        NOT NULL REFERENCES auth_user (id),
  updated_at  timestamptz NOT NULL,
  CONSTRAINT connectors_mapping_source_uq UNIQUE (target, company_id, source_name)
);

REVOKE DELETE, TRUNCATE ON TABLE connectors_import, connectors_mapping FROM eve_app;

-- org write paths (spec §8): structure change requests, the apply_assignment command, corrections.

-- A bundle of structure changes with its impact analysis. The approval itself lives in
-- approvals_request; this row is the working copy (edited when the request is returned and sent
-- again) and records when it was applied.
CREATE TABLE org_change_request (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES org_company (company_id),
  effective_date      date        NOT NULL,
  reason              text        NOT NULL CHECK (reason <> ''),
  operations          jsonb       NOT NULL,
  impact              jsonb       NOT NULL,
  status              text        NOT NULL CHECK (status IN ('submitted', 'applied')),
  approval_request_id uuid        REFERENCES approvals_request (id),
  requested_by        text        NOT NULL,
  revision            integer     NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  applied_at          timestamptz,
  CONSTRAINT org_change_request_applied_ck CHECK ((status = 'applied') = (applied_at IS NOT NULL))
);
CREATE INDEX org_change_request_company_idx ON org_change_request (company_id, created_at DESC);

-- apply_assignment is idempotent on the personnel action's id: a replay finds its result here.
CREATE TABLE org_applied_action (
  action_id   text        PRIMARY KEY,
  company_id  uuid        NOT NULL REFERENCES org_company (company_id),
  approval_id uuid        NOT NULL REFERENCES approvals_request (id),
  command     jsonb       NOT NULL,
  result      jsonb       NOT NULL,
  applied_at  timestamptz NOT NULL
);

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE org_change_request, org_applied_action FROM eve_app;
GRANT UPDATE (effective_date, reason, operations, impact, status, approval_request_id, revision,
  updated_at, applied_at) ON TABLE org_change_request TO eve_app;

-- Corrections fix a wrong entry in place, for the whole period of its version (product-owner
-- decision 2026-11-25); the audit log keeps the old value. Descriptive columns only: parents,
-- units, reporting lines and assignments change through change requests.
GRANT UPDATE (legacy_code, name_fa, name_en, level_id, cost_center, location, supervisor_position_id)
  ON TABLE org_unit_version TO eve_app;
GRANT UPDATE (legacy_code, title_fa, title_en, type, fte, supervisory)
  ON TABLE org_position_version TO eve_app;

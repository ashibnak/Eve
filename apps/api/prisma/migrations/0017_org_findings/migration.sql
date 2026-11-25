-- org findings (spec §5, F5): results of the consistency rules R1-R15, and the runs that made them.

-- One evaluation of the rules over one company on one date. Written once, at the end of the run.
CREATE TABLE org_rule_run (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES org_company (company_id),
  as_of       date        NOT NULL,
  -- Parameters were resolved as known at this moment (bitemporal parameters, ADR-009).
  known_at    timestamptz NOT NULL,
  trigger     text        NOT NULL CHECK (trigger IN ('nightly', 'manual')),
  -- Per rule: code, template id + version, parameter version, parameter hash, violations.
  rules       jsonb       NOT NULL,
  opened      integer     NOT NULL,
  resolved    integer     NOT NULL,
  still_open  integer     NOT NULL,
  accepted    integer     NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL
);
CREATE INDEX org_rule_run_company_idx ON org_rule_run (company_id, finished_at DESC);

CREATE TABLE org_finding (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES org_company (company_id),
  code              text        NOT NULL,
  rule_id           text        NOT NULL,
  -- The template version and parameters of the latest run that saw it (ADR-005 replay).
  rule_version      integer     NOT NULL,
  param_version_id  uuid,
  params_hash       text        NOT NULL,
  severity          text        NOT NULL CHECK (severity IN ('blocking', 'warning', 'info')),
  subject_type      text        NOT NULL CHECK (subject_type IN ('company', 'unit', 'position', 'person')),
  subject_id        uuid        NOT NULL,
  key               text        NOT NULL,
  -- rule id + subject + key: the same case across runs, template versions and parameters.
  fingerprint       text        NOT NULL,
  detail            jsonb       NOT NULL,
  status            text        NOT NULL CHECK (status IN ('open', 'resolved', 'accepted')),
  first_run_id      uuid        NOT NULL REFERENCES org_rule_run (id),
  last_run_id       uuid        NOT NULL REFERENCES org_rule_run (id),
  first_seen_at     timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  resolved_at       timestamptz,
  accepted_by       text,
  accepted_at       timestamptz,
  accepted_reason   text,
  reopened_by       text,
  reopened_at       timestamptz,
  reopened_reason   text,
  CONSTRAINT org_finding_accepted_ck CHECK (
    status <> 'accepted' OR (accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND accepted_reason <> '')),
  CONSTRAINT org_finding_resolved_ck CHECK (status <> 'resolved' OR resolved_at IS NOT NULL)
);
-- One live finding per case: an open or accepted one. Resolved ones are history.
CREATE UNIQUE INDEX org_finding_live_uq ON org_finding (company_id, fingerprint)
  WHERE status IN ('open', 'accepted');
CREATE INDEX org_finding_inbox_idx ON org_finding (company_id, status, severity);

-- Runs are written once; findings change only in their lifecycle columns, never deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE org_rule_run FROM eve_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE org_finding FROM eve_app;
GRANT UPDATE (rule_version, param_version_id, params_hash, detail, status, last_run_id, last_seen_at,
  resolved_at, accepted_by, accepted_at, accepted_reason, reopened_by, reopened_at, reopened_reason)
  ON TABLE org_finding TO eve_app;

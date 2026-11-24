-- Customer parameters of rule templates (ADR-005), bitemporal (ADR-009):
--   valid_from / valid_to          business dates the values apply to ([from, to), to NULL = open)
--   recorded_at / superseded_at    when the system knew them; a change supersedes rows, never edits values.
-- Bound to an exact template version, so replaying a decision never mixes versions.
CREATE TABLE rules_param_version (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         text        NOT NULL,
  template_version    integer     NOT NULL CHECK (template_version >= 1),
  -- NULL = customer-wide; a company row overrides it for that company.
  company_id          uuid        REFERENCES core_company (id),
  params              jsonb       NOT NULL,
  valid_from          date        NOT NULL,
  valid_to            date,
  recorded_at         timestamptz NOT NULL,
  superseded_at       timestamptz,
  approval_request_id uuid,
  CONSTRAINT rules_param_version_period_ck CHECK (valid_to IS NULL OR valid_to > valid_from),
  -- At most one current value per template version, company and day.
  CONSTRAINT rules_param_version_no_overlap EXCLUDE USING gist (
    template_id WITH =,
    template_version WITH =,
    (COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL)
);
CREATE INDEX rules_param_version_lookup_idx
  ON rules_param_version (template_id, template_version, company_id, valid_from);

-- Values are never rewritten: the app may only stamp superseded_at.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE rules_param_version FROM eve_app;
GRANT UPDATE (superseded_at) ON TABLE rules_param_version TO eve_app;

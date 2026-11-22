-- Append-only, hash-chained audit log (CLAUDE.md rule 9).
-- hash = sha256(prev_hash || canonical JSON of the row's content); see platform/audit.
CREATE TABLE audit_log (
  seq            bigserial   PRIMARY KEY,
  id             uuid        NOT NULL UNIQUE,
  recorded_at    timestamptz NOT NULL,
  company_id     uuid        REFERENCES core_company (id),
  actor          jsonb       NOT NULL,
  source         text        NOT NULL CHECK (source IN ('manual', 'file', 'agent', 'workflow')),
  action         text        NOT NULL,
  entity_type    text        NOT NULL,
  entity_id      text        NOT NULL,
  before         jsonb,
  after          jsonb,
  reason         text        NOT NULL CHECK (reason <> ''),
  correlation_id uuid        NOT NULL,
  request_id     text,
  action_id      text,
  prev_hash      char(64)    NOT NULL,
  hash           char(64)    NOT NULL UNIQUE
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, seq);
CREATE INDEX audit_log_correlation_idx ON audit_log (correlation_id);
CREATE INDEX audit_log_company_idx ON audit_log (company_id, seq);

-- The app role may only append and read.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_log FROM eve_app;

-- Second line of defence: nobody (including the owner) changes rows without disabling this.
CREATE FUNCTION audit_log_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% rejected)', TG_OP;
END
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();

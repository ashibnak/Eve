-- org events that wait for their effective date (spec §7: "published at the effective date, not
-- earlier"). A change approved today for next month is written now with its valid_from; its events
-- are kept here with the flow they belong to and published by a daily job on the day.

CREATE TABLE org_pending_event (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL REFERENCES org_company (company_id),
  type           text        NOT NULL,
  schema_version integer     NOT NULL,
  payload        jsonb       NOT NULL,
  effective_at   date        NOT NULL,
  -- The flow that caused it (ADR-006): kept so the event carries the same correlation.
  correlation_id uuid        NOT NULL,
  causation_id   uuid,
  actor          jsonb       NOT NULL,
  source         text        NOT NULL,
  created_at     timestamptz NOT NULL,
  published_at   timestamptz,
  -- The outbox event id once published.
  event_id       uuid,
  CONSTRAINT org_pending_event_published_ck CHECK ((published_at IS NULL) = (event_id IS NULL))
);
CREATE INDEX org_pending_event_due_idx ON org_pending_event (effective_at) WHERE published_at IS NULL;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE org_pending_event FROM eve_app;
GRANT UPDATE (published_at, event_id) ON TABLE org_pending_event TO eve_app;

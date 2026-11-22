-- Transactional outbox (ADR-006): events are written in the same transaction as the change
-- and relayed to pg-boss afterwards.
CREATE TABLE events_outbox (
  event_id         uuid        PRIMARY KEY,
  type             text        NOT NULL,
  schema_version   integer     NOT NULL CHECK (schema_version >= 1),
  occurred_at      timestamptz NOT NULL,
  effective_at     date        NOT NULL,
  correlation_id   uuid        NOT NULL,
  causation_id     uuid,
  actor            jsonb       NOT NULL,
  source           text        NOT NULL CHECK (source IN ('manual', 'file', 'agent', 'workflow')),
  company_id       uuid        REFERENCES core_company (id),
  payload          jsonb       NOT NULL,
  published_at     timestamptz,
  publish_attempts integer     NOT NULL DEFAULT 0,
  last_error       text
);

CREATE INDEX events_outbox_pending_idx ON events_outbox (occurred_at, event_id) WHERE published_at IS NULL;
CREATE INDEX events_outbox_correlation_idx ON events_outbox (correlation_id);

-- Published events are history; the app never removes them.
REVOKE DELETE, TRUNCATE ON TABLE events_outbox FROM eve_app;

-- Idempotent consumers: one row per (consumer, event) processed, written in the handler's transaction.
CREATE TABLE events_inbox (
  consumer     text        NOT NULL,
  event_id     uuid        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

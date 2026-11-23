-- Relay events in the exact order they were written. occurred_at has millisecond ties (several
-- events in one transaction) and event_id is random, so neither gives a reliable order.
ALTER TABLE events_outbox ADD COLUMN seq bigserial NOT NULL;
CREATE UNIQUE INDEX events_outbox_seq_key ON events_outbox (seq);

DROP INDEX events_outbox_pending_idx;
CREATE INDEX events_outbox_pending_idx ON events_outbox (seq) WHERE published_at IS NULL;

-- Usage ledger and counters (ADR-014). Days are calendar days in the customer's time zone, so a
-- month in any calendar (Jalali for ir) is a range of days. Aggregates only; reports never name people.
CREATE TABLE usage_daily (
  day    date   NOT NULL,
  module text   NOT NULL,
  metric text   NOT NULL,
  count  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, module, metric)
);

-- One row per user per day with any authenticated request: monthly active users = distinct users
-- over the month's days.
CREATE TABLE usage_active_user (
  day     date NOT NULL,
  user_id uuid NOT NULL REFERENCES auth_user (id),
  PRIMARY KEY (day, user_id)
);

-- One row per model call or decision. Token fields are present for AI usage billing (B5) but no
-- module calls a model in R1.
CREATE TABLE usage_ledger (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL,
  day         date        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('llm_call', 'decision')),
  module      text        NOT NULL,
  skill       text,
  model       text,
  tokens_in   integer CHECK (tokens_in >= 0),
  tokens_out  integer CHECK (tokens_out >= 0),
  duration_ms integer CHECK (duration_ms >= 0),
  user_id     uuid REFERENCES auth_user (id),
  company_id  uuid REFERENCES core_company (id)
);
CREATE INDEX usage_ledger_day_idx ON usage_ledger (day, module);

REVOKE DELETE, TRUNCATE ON usage_daily, usage_active_user, usage_ledger FROM eve_app;

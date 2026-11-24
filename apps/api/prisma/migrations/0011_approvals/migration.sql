-- Approval requests: a state machine on PostgreSQL (no in-memory waits; survives restarts).
-- chain and pinned_rules are fixed at submission: a running request keeps them until it ends.
CREATE TABLE approvals_request (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text        NOT NULL,
  company_id     uuid        REFERENCES core_company (id),
  payload        jsonb       NOT NULL,
  revision       integer     NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status         text        NOT NULL
                 CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
  current_step   integer     NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  -- Ordered role names, one per step.
  chain          jsonb       NOT NULL
                 CHECK (jsonb_typeof(chain) = 'array' AND jsonb_array_length(chain) >= 1),
  -- Rule template versions pinned for this request: {"<rule id>": <version>}.
  pinned_rules   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  requested_by   uuid        NOT NULL REFERENCES auth_user (id),
  correlation_id uuid        NOT NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  decided_at     timestamptz
);
CREATE INDEX approvals_request_pending_idx ON approvals_request (type, company_id) WHERE status = 'pending';
CREATE INDEX approvals_request_requester_idx ON approvals_request (requested_by, status);

-- Append-only history of every action on a request.
CREATE TABLE approvals_action (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid        NOT NULL REFERENCES approvals_request (id),
  revision   integer     NOT NULL,
  step       integer     NOT NULL,
  action     text        NOT NULL
             CHECK (action IN ('submit', 'approve', 'reject', 'return', 'resubmit', 'cancel')),
  actor_id   uuid        NOT NULL REFERENCES auth_user (id),
  note       text,
  payload    jsonb,
  at         timestamptz NOT NULL
);
CREATE INDEX approvals_action_request_idx ON approvals_action (request_id, at);

REVOKE DELETE, TRUNCATE ON TABLE approvals_request FROM eve_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE approvals_action FROM eve_app;

ALTER TABLE rules_param_version
  ADD CONSTRAINT rules_param_version_approval_fk
  FOREIGN KEY (approval_request_id) REFERENCES approvals_request (id);

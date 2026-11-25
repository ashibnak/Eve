-- Requests whose effective date passes while they wait become 'expired' (S2 follow-up,
-- product-owner decision 2026-11-25). Expiry is a system action, so it has no user actor.
ALTER TABLE approvals_request DROP CONSTRAINT approvals_request_status_check;
ALTER TABLE approvals_request ADD CONSTRAINT approvals_request_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled', 'expired'));

ALTER TABLE approvals_action DROP CONSTRAINT approvals_action_action_check;
ALTER TABLE approvals_action ADD CONSTRAINT approvals_action_action_check
  CHECK (action IN ('submit', 'approve', 'reject', 'return', 'resubmit', 'cancel', 'expire'));

ALTER TABLE approvals_action ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE approvals_action ADD CONSTRAINT approvals_action_actor_ck
  CHECK (actor_id IS NOT NULL OR action = 'expire');

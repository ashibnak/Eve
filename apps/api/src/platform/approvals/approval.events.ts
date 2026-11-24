import { platformV1 } from '@eve/contracts';
import { defineEvent } from '../events/event-registry';

/** A step is waiting for someone holding `role` (feeds notifications and the inbox later). */
export const ApprovalRequested = defineEvent({
  type: 'platform.approval.requested',
  schemaVersion: 1,
  payload: platformV1.ApprovalRequestedPayload,
});

/** A request reached a final state: approved, rejected or cancelled. */
export const ApprovalDecided = defineEvent({
  type: 'platform.approval.decided',
  schemaVersion: 1,
  payload: platformV1.ApprovalDecidedPayload,
});

/** A request was sent back to its requester for changes. */
export const ApprovalReturned = defineEvent({
  type: 'platform.approval.returned',
  schemaVersion: 1,
  payload: platformV1.ApprovalReturnedPayload,
});

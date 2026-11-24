import { z } from 'zod';

/**
 * `pending → approved | rejected | returned`; `returned → pending` on resubmission (a new
 * revision, back to the first step); `pending | returned → cancelled` by the requester.
 */
export const ApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'returned',
  'cancelled',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalActionKindSchema = z.enum([
  'submit',
  'approve',
  'reject',
  'return',
  'resubmit',
  'cancel',
]);
export type ApprovalActionKind = z.infer<typeof ApprovalActionKindSchema>;

/** Payload of `platform.approval.requested@1`: a step is waiting for someone with `role`. */
export const ApprovalRequestedPayload = z.object({
  request_id: z.uuid(),
  request_type: z.string(),
  revision: z.number().int().min(1),
  step: z.number().int().min(0),
  role: z.string(),
});

/** Payload of `platform.approval.decided@1`: the request reached a final state. */
export const ApprovalDecidedPayload = z.object({
  request_id: z.uuid(),
  request_type: z.string(),
  outcome: z.enum(['approved', 'rejected', 'cancelled']),
});

/** Payload of `platform.approval.returned@1`: sent back to the requester for changes. */
export const ApprovalReturnedPayload = z.object({
  request_id: z.uuid(),
  request_type: z.string(),
  revision: z.number().int().min(1),
});

import { z } from 'zod';
import { ActorSchema } from './actor.js';
import { AuditSourceSchema } from './audit-source.js';
import { BusinessDateSchema, InstantSchema } from './dates.js';

/** `<component-or-slug>.<entity>.<verb>`, e.g. `org.position.created`, `platform.config.changed`. */
export const EventTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/, 'event type must look like slug.entity.verb');

/** Standard event envelope (ADR-006). Receivers ignore unknown fields. */
export const EventEnvelopeSchema = z.object({
  event_id: z.uuid(),
  type: EventTypeSchema,
  schema_version: z.number().int().min(1),
  /** When the event was recorded. */
  occurred_at: InstantSchema,
  /** The business date the change takes effect. */
  effective_at: BusinessDateSchema,
  /** The whole flow (e.g. one personnel action) shares one correlation id. */
  correlation_id: z.uuid(),
  /** The event or command that caused this one; null for a flow's first step. */
  causation_id: z.uuid().nullable(),
  actor: ActorSchema,
  source: AuditSourceSchema,
  /** Access scope of the event; null only for customer-wide platform events. */
  company_id: z.uuid().nullable(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** An envelope with its typed payload, as stored in the outbox and delivered to consumers. */
export type EventMessage<TPayload> = EventEnvelope & { payload: TPayload };

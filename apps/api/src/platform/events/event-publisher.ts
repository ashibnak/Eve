import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import type { z } from 'zod';
import { toCanonicalValue } from '../audit/canonical-json';
import { Clock } from '../context/clock';
import { currentContext } from '../context/request-context';
import { type Tx } from '../context/tx-runner';
import { type EventDefinition, EventRegistry } from './event-registry';

export interface PublishRequest<TSchema extends z.ZodType> {
  event: EventDefinition<TSchema>;
  payload: z.input<TSchema>;
  /** Business date the change takes effect; always explicit, never defaulted. */
  effectiveAt: platformV1.BusinessDate;
  companyId: string | null;
}

/**
 * Publishes events only through the outbox, inside the caller's transaction (CLAUDE.md rule 10).
 * The relay hands them to pg-boss after commit, so an event exists if and only if its change does.
 */
@Injectable()
export class EventPublisher {
  constructor(
    private readonly registry: EventRegistry,
    private readonly clock: Clock,
  ) {}

  async publish<TSchema extends z.ZodType>(
    tx: Tx,
    request: PublishRequest<TSchema>,
  ): Promise<platformV1.EventMessage<z.output<TSchema>>> {
    const { event } = request;
    const registered = this.registry.get(event.type, event.schemaVersion);
    const payload = toCanonicalValue<z.output<TSchema>>(registered.payload.parse(request.payload));
    const ctx = currentContext();

    const message: platformV1.EventMessage<z.output<TSchema>> = {
      event_id: randomUUID(),
      type: event.type,
      schema_version: event.schemaVersion,
      occurred_at: this.clock.now().toISOString() as platformV1.Instant,
      effective_at: request.effectiveAt,
      correlation_id: ctx.correlationId,
      causation_id: ctx.causationId,
      actor: ctx.actor,
      source: ctx.source,
      company_id: request.companyId,
      payload,
    };

    await tx.eventsOutbox.create({
      data: {
        eventId: message.event_id,
        type: message.type,
        schemaVersion: message.schema_version,
        occurredAt: new Date(message.occurred_at),
        effectiveAt: new Date(`${message.effective_at}T00:00:00.000Z`),
        correlationId: message.correlation_id,
        causationId: message.causation_id,
        actor: message.actor,
        source: message.source,
        companyId: message.company_id,
        payload: message.payload as object,
      },
    });
    return message;
  }
}

import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import type { z } from 'zod';
import { toCanonicalValue } from '../../../../platform/audit/canonical-json';
import { ConfigService } from '../../../../platform/config/config.service';
import { TimeZoneSetting } from '../../../../platform/config/settings';
import { Clock } from '../../../../platform/context/clock';
import { currentContext, runWithContext } from '../../../../platform/context/request-context';
import { type Tx, TxRunner } from '../../../../platform/context/tx-runner';
import { businessDateIn } from '../../../../platform/dates/dates';
import { type EventDefinition, EventRegistry } from '../../../../platform/events/event-registry';
import { EventPublisher } from '../../../../platform/events/event-publisher';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { dateOf, dayOf } from '../model/period';

/**
 * Where org writes put their events (spec §7: "published at the effective date, not earlier").
 * An event effective today or earlier goes to the outbox in the caller's transaction; a later one
 * waits in `org_pending_event` with the flow it belongs to, and the daily job publishes it on the
 * day with the same correlation id, actor and source.
 */
@Injectable()
export class OrgEventSink {
  constructor(
    private readonly events: EventPublisher,
    private readonly registry: EventRegistry,
    private readonly db: ScopedDb,
    private readonly txRunner: TxRunner,
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  async emit<TSchema extends z.ZodType>(
    tx: Tx,
    request: {
      event: EventDefinition<TSchema>;
      payload: z.input<TSchema>;
      effectiveAt: platformV1.BusinessDate;
      companyId: string;
    },
    today: platformV1.BusinessDate,
  ): Promise<void> {
    if (request.effectiveAt <= today) {
      await this.events.publish(tx, request);
      return;
    }
    const registered = this.registry.get(request.event.type, request.event.schemaVersion);
    const ctx = currentContext();
    await tx.orgPendingEvent.create({
      data: {
        companyId: request.companyId,
        type: request.event.type,
        schemaVersion: request.event.schemaVersion,
        payload: toCanonicalValue(registered.payload.parse(request.payload)) as object,
        effectiveAt: dateOf(request.effectiveAt),
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
        actor: ctx.actor,
        source: ctx.source,
        createdAt: this.clock.now(),
      },
    });
  }

  /** The customer's today (events effective on or before it are due). */
  async today(): Promise<platformV1.BusinessDate> {
    return businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting));
  }

  /** Daily job: publishes every waiting event whose effective date has come. Returns how many. */
  async publishDue(): Promise<number> {
    const today = await this.today();
    const due = await this.db.afterOwnCheck().orgPendingEvent.findMany({
      where: { publishedAt: null, effectiveAt: { lte: dateOf(today) } },
      orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const pending of due) {
      const flow = {
        actor: pending.actor as platformV1.Actor,
        source: pending.source as platformV1.AuditSource,
        correlationId: pending.correlationId,
        causationId: pending.causationId,
        requestId: null,
        actionId: null,
      };
      // Published in the flow that caused it (same correlation id, actor and source).
      await runWithContext(flow, () =>
        this.txRunner.run(async (tx) => {
          // Lock the row, so two job runs never publish it twice.
          const [row] = await tx.$queryRaw<{ published_at: Date | null }[]>`
            SELECT published_at FROM org_pending_event WHERE id = ${pending.id}::uuid FOR UPDATE`;
          if (!row || row.published_at) return;
          const message = await this.events.publish(tx, {
            event: this.registry.get(pending.type, pending.schemaVersion),
            payload: pending.payload,
            effectiveAt: dayOf(pending.effectiveAt),
            companyId: pending.companyId,
          });
          await tx.orgPendingEvent.update({
            where: { id: pending.id },
            data: { publishedAt: this.clock.now(), eventId: message.event_id },
          });
        }),
      );
    }
    return due.length;
  }
}

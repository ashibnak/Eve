import { Injectable, Logger } from '@nestjs/common';
import { platformV1 } from '@eve/contracts';
import type { z } from 'zod';
import { runWithContext } from '../context/request-context';
import { type Tx, TxRunner } from '../context/tx-runner';
import { JobsService } from '../jobs/jobs.service';
import { type EventDefinition, EventRegistry } from './event-registry';
import { busEventName, type RelayedJob } from './outbox-relay';

/**
 * A subscriber to one event type and version. `handle` runs in one transaction with the inbox
 * record, so a redelivered event is skipped and a failed handler leaves no trace.
 * No handler may open a decision unless the decision graph names this event as its trigger
 * (CLAUDE.md rule 10).
 */
export interface EventConsumer<TSchema extends z.ZodType = z.ZodType> {
  /** Stable, unique name; also the pg-boss queue suffix and the inbox key. */
  name: string;
  event: EventDefinition<TSchema>;
  handle(tx: Tx, message: platformV1.EventMessage<z.output<TSchema>>): Promise<void>;
}

export type DeliveryResult = 'applied' | 'duplicate';

/**
 * pg-boss defaults (one job per fetch, a 2 s pause between fetches) would drain a backlog at
 * about 30 events a minute. Fetch in batches and keep fetching while batches come back full;
 * report each job's outcome separately so one failing event is retried alone.
 */
const CONSUMER_WORK_OPTIONS = {
  batchSize: 20,
  burstWhenBatchFull: true,
  pollingIntervalSeconds: 1,
  perJobResults: true,
} as const;

@Injectable()
export class EventConsumers {
  private readonly logger = new Logger(EventConsumers.name);
  private readonly consumers = new Map<string, EventConsumer>();

  constructor(
    private readonly registry: EventRegistry,
    private readonly txRunner: TxRunner,
    private readonly jobs: JobsService,
  ) {}

  register<TSchema extends z.ZodType>(consumer: EventConsumer<TSchema>): void {
    if (!/^[a-z][a-z0-9_.-]*$/.test(consumer.name)) {
      throw new Error(`Invalid consumer name "${consumer.name}"`);
    }
    if (this.consumers.has(consumer.name)) {
      throw new Error(`Consumer ${consumer.name} is already registered`);
    }
    this.registry.get(consumer.event.type, consumer.event.schemaVersion);
    this.consumers.set(consumer.name, consumer as unknown as EventConsumer);
  }

  /** Creates each consumer's queue, subscribes it to its event and starts working it. */
  async start(): Promise<void> {
    const boss = this.jobs.instance;
    for (const consumer of this.consumers.values()) {
      const queue = `consumer.${consumer.name}`;
      await boss.createQueue(queue);
      await boss.subscribe(busEventName(consumer.event.type, consumer.event.schemaVersion), queue);
      await boss.work<RelayedJob>(queue, CONSUMER_WORK_OPTIONS, async (jobs) => {
        // pg-boss returns a batch unordered; process it sequentially in outbox (write) order.
        const ordered = [...jobs].sort((a, b) =>
          BigInt(a.data.outbox_seq) < BigInt(b.data.outbox_seq) ? -1 : 1,
        );
        const results = [];
        for (const job of ordered) {
          try {
            await this.deliver(consumer.name, job.data);
            results.push({ id: job.id, status: 'completed' as const });
          } catch (error) {
            this.logger.error(`Consumer ${consumer.name} failed on job ${job.id}`, error);
            results.push({
              id: job.id,
              status: 'failed' as const,
              output: { message: error instanceof Error ? error.message : String(error) },
            });
          }
        }
        return results;
      });
    }
  }

  /** Validates and applies one delivery, idempotently on `event_id`. */
  async deliver(consumerName: string, raw: unknown): Promise<DeliveryResult> {
    const consumer = this.consumers.get(consumerName);
    if (!consumer) throw new Error(`Unknown consumer ${consumerName}`);
    const envelope = platformV1.EventEnvelopeSchema.parse(raw);
    const definition = this.registry.get(envelope.type, envelope.schema_version);
    const payload: unknown = definition.payload.parse((raw as { payload?: unknown }).payload);
    const message = { ...envelope, payload };

    return runWithContext(
      {
        actor: { kind: 'system', id: `consumer:${consumer.name}` },
        source: 'workflow',
        correlationId: envelope.correlation_id,
        causationId: envelope.event_id,
        requestId: null,
        actionId: null,
      },
      () =>
        this.txRunner.run(async (tx): Promise<DeliveryResult> => {
          const inserted = await tx.$executeRaw`
            INSERT INTO events_inbox (consumer, event_id)
            VALUES (${consumer.name}, ${envelope.event_id}::uuid)
            ON CONFLICT DO NOTHING`;
          if (inserted === 0) {
            this.logger.debug(`Skipping duplicate ${envelope.event_id} for ${consumer.name}`);
            return 'duplicate';
          }
          await consumer.handle(tx, message);
          return 'applied';
        }),
    );
  }
}

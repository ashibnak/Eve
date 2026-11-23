import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { TxRunner } from '../context/tx-runner';
import { JobsService, txDatabase } from '../jobs/jobs.service';

interface OutboxRow {
  seq: bigint;
  event_id: string;
  type: string;
  schema_version: number;
  occurred_at: Date;
  effective_at: Date;
  correlation_id: string;
  causation_id: string | null;
  actor: platformV1.Actor;
  source: platformV1.AuditSource;
  company_id: string | null;
  payload: unknown;
}

/**
 * Job data: the event message plus its outbox position, which consumers use to process a fetched
 * batch in write order (pg-boss returns a batch unordered). Not part of the envelope contract.
 */
export type RelayedJob = platformV1.EventMessage<unknown> & { outbox_seq: string };

/** pg-boss event name for one event type and schema version ("@" is not allowed in names). */
export function busEventName(type: string, schemaVersion: number): string {
  return `${type}/v${schemaVersion}`;
}

/**
 * Moves committed outbox rows to pg-boss, oldest first. Each event is relayed in its own
 * transaction that claims the row, creates the jobs and stamps `published_at`, so it reaches each
 * subscribed queue exactly once even if the relay crashes. One transaction per event also gives
 * every job its own `created_on`, which is the order pg-boss hands jobs to consumers (it has no
 * tie-breaker), so a consumer sees events in the order they were written. Retried failures and a
 * second relay process can still reorder; consumers must stay correct under reordering.
 */
@Injectable()
export class OutboxRelay implements OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<number> | undefined;

  constructor(
    private readonly txRunner: TxRunner,
    private readonly jobs: JobsService,
  ) {}

  /** Publishes up to `limit` pending events; returns how many were relayed. */
  relayPending(limit = 100): Promise<number> {
    this.running ??= this.relayBatch(limit).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  startPolling(intervalMs: number): void {
    this.timer ??= setInterval(() => {
      this.relayPending().catch((error: unknown) => this.logger.error(error));
    }, intervalMs);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async relayBatch(limit: number): Promise<number> {
    let relayed = 0;
    while (relayed < limit && (await this.relayNext())) relayed += 1;
    return relayed;
  }

  /** Relays the oldest unpublished event; false when there is none. */
  private relayNext(): Promise<boolean> {
    const boss = this.jobs.instance;
    return this.txRunner.run(async (tx) => {
      const [row] = await tx.$queryRaw<OutboxRow[]>`
        SELECT seq, event_id, type, schema_version, occurred_at, effective_at, correlation_id,
               causation_id, actor, source, company_id, payload
        FROM events_outbox
        WHERE published_at IS NULL
        ORDER BY seq
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;
      if (!row) return false;

      const message: platformV1.EventMessage<unknown> = {
        event_id: row.event_id,
        type: row.type,
        schema_version: row.schema_version,
        occurred_at: row.occurred_at.toISOString() as platformV1.Instant,
        effective_at: row.effective_at.toISOString().slice(0, 10) as platformV1.BusinessDate,
        correlation_id: row.correlation_id,
        causation_id: row.causation_id,
        actor: row.actor,
        source: row.source,
        company_id: row.company_id,
        payload: row.payload,
      };
      const job: RelayedJob = { ...message, outbox_seq: row.seq.toString() };
      await boss.publish(busEventName(row.type, row.schema_version), job, {
        id: row.event_id,
        db: txDatabase(tx),
      });
      await tx.$executeRaw`
        UPDATE events_outbox
        SET published_at = now(), publish_attempts = publish_attempts + 1
        WHERE event_id = ${row.event_id}::uuid`;
      return true;
    });
  }
}

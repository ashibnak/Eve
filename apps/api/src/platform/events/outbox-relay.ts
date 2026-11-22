import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { TxRunner } from '../context/tx-runner';
import { JobsService, txDatabase } from '../jobs/jobs.service';

interface OutboxRow {
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

/** pg-boss event name for one event type and schema version ("@" is not allowed in names). */
export function busEventName(type: string, schemaVersion: number): string {
  return `${type}/v${schemaVersion}`;
}

/**
 * Moves committed outbox rows to pg-boss. Claiming the rows, creating the jobs and stamping
 * `published_at` happen in one transaction, so each event reaches each subscribed queue
 * exactly once even if the relay crashes or two relays run at the same time.
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

  private relayBatch(limit: number): Promise<number> {
    const boss = this.jobs.instance;
    return this.txRunner.run(async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT event_id, type, schema_version, occurred_at, effective_at, correlation_id,
               causation_id, actor, source, company_id, payload
        FROM events_outbox
        WHERE published_at IS NULL
        ORDER BY occurred_at, event_id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return 0;

      const db = txDatabase(tx);
      for (const row of rows) {
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
        await boss.publish(busEventName(row.type, row.schema_version), message, {
          id: row.event_id,
          db,
        });
      }
      const ids = rows.map((row) => row.event_id);
      await tx.$executeRaw`
        UPDATE events_outbox
        SET published_at = now(), publish_attempts = publish_attempts + 1
        WHERE event_id = ANY(${ids}::uuid[])`;
      return rows.length;
    });
  }
}

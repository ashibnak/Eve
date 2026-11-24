import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { type Tx } from '../context/tx-runner';

/** Schema created by migration 0006 and owned by the app role; pg-boss manages its tables. */
export const PG_BOSS_SCHEMA = 'pgboss';

/** pg-boss database adapter that runs its statements inside one of our transactions. */
export function txDatabase(tx: Tx) {
  return {
    executeSql: async (text: string, values: unknown[] = []) => ({
      rows: await tx.$queryRawUnsafe<unknown[]>(text, ...values),
    }),
  };
}

/**
 * Background jobs and event delivery on PostgreSQL (pg-boss; no Redis, CLAUDE.md rule 1).
 * Server and worker share one image; the worker side starts with the application.
 */
/** A recurring job: a pg-boss queue with a cron schedule (UTC) and its handler. */
export interface ScheduledJob {
  /** Queue name, e.g. `platform.connectors.retention`. */
  name: string;
  cron: string;
  handler: () => Promise<unknown>;
}

@Injectable()
export class JobsService implements OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private boss: PgBoss | undefined;
  private readonly scheduled: ScheduledJob[] = [];

  /** Registers a recurring job; it starts when the worker starts (not in API-only instances). */
  schedule(job: ScheduledJob): void {
    if (this.scheduled.some((j) => j.name === job.name))
      throw new Error(`Job ${job.name} is already scheduled`);
    this.scheduled.push(job);
  }

  async start(connectionString: string): Promise<PgBoss> {
    if (this.boss) return this.boss;
    const boss = new PgBoss({
      connectionString,
      schema: PG_BOSS_SCHEMA,
      createSchema: false,
      migrate: true,
      application_name: 'eve-jobs',
    });
    boss.on('error', (error) => this.logger.error(error));
    await boss.start();
    for (const job of this.scheduled) {
      await boss.createQueue(job.name);
      await boss.schedule(job.name, job.cron);
      await boss.work(job.name, async () => {
        await job.handler();
      });
    }
    this.boss = boss;
    return boss;
  }

  get instance(): PgBoss {
    if (!this.boss) throw new Error('Jobs not started');
    return this.boss;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true, timeout: 10_000 });
    this.boss = undefined;
  }
}

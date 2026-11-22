import { Global, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { JobsService } from '../jobs/jobs.service';
import { EventConsumers } from './event-consumers';
import { EventPublisher } from './event-publisher';
import { EventRegistry } from './event-registry';
import { OutboxRelay } from './outbox-relay';

const RELAY_INTERVAL_MS = 1_000;

@Global()
@Module({
  providers: [EventRegistry, EventPublisher, OutboxRelay, EventConsumers],
  exports: [EventRegistry, EventPublisher, OutboxRelay, EventConsumers],
})
export class EventsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(EventsModule.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly consumers: EventConsumers,
    private readonly relay: OutboxRelay,
  ) {}

  /**
   * Starts the worker side (pg-boss, consumers, outbox relay) in the same process as the API.
   * EVE_WORKER=off runs an API-only instance.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.EVE_WORKER === 'off') return;
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    await this.jobs.start(url);
    await this.consumers.start();
    this.relay.startPolling(RELAY_INTERVAL_MS);
    this.logger.log('Worker started: pg-boss, event consumers, outbox relay');
  }
}

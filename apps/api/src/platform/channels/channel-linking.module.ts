import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Clock } from '../context/clock';
import { TxRunner } from '../context/tx-runner';
import { PrismaService } from '../db/prisma.service';
import type { BaleClient } from './bale/bale.client';
import { BalePoller } from './bale/bale.poller';
import { BALE_CLIENT } from './channels.module';
import { InboundHandlers } from './inbound';
import { ChannelLinking } from './linking';

/** Runs the Bale poller with the application when a bot token is configured. */
@Injectable()
export class BalePolling implements OnApplicationBootstrap, OnApplicationShutdown {
  private poller: BalePoller | null = null;

  constructor(
    @Inject(BALE_CLIENT) private readonly client: BaleClient | null,
    private readonly prisma: PrismaService,
    private readonly txRunner: TxRunner,
    private readonly linking: ChannelLinking,
    private readonly handlers: InboundHandlers,
    private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    const databaseUrl = process.env.DATABASE_URL;
    if (!this.client || !databaseUrl) return;
    this.poller = new BalePoller({
      client: this.client,
      prisma: this.prisma,
      txRunner: this.txRunner,
      linking: this.linking,
      handlers: this.handlers,
      clock: this.clock,
      databaseUrl,
    });
    this.poller.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.poller?.stop();
  }
}

/** Self-service linking of channel accounts to people, and the Bale poller (S12). */
@Global()
@Module({
  providers: [ChannelLinking, BalePolling],
  exports: [ChannelLinking],
})
export class ChannelLinkingModule {}

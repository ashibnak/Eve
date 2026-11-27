import { Global, Logger, Module } from '@nestjs/common';
import { BaleChannel } from './bale/bale.channel';
import { BaleClient } from './bale/bale.client';
import { ChannelRegistry } from './channel';
import { ChannelIdentities } from './identity';
import { InboundHandlers } from './inbound';
import { StubChannel } from './stub.channel';
import { UserNotifier } from './user-notifier';

/** The Bale Bot API client, or null when no bot token is configured (then only the stub exists). */
export const BALE_CLIENT = Symbol('BaleClient');

export function baleClientFromEnv(env: NodeJS.ProcessEnv = process.env): BaleClient | null {
  const token = env.EVE_BALE_BOT_TOKEN?.trim();
  if (!token) return null;
  return new BaleClient({ baseUrl: env.EVE_BALE_API_URL?.trim() || 'https://tapi.bale.ai', token });
}

@Global()
@Module({
  providers: [
    { provide: BALE_CLIENT, useFactory: () => baleClientFromEnv() },
    {
      provide: ChannelRegistry,
      inject: [BALE_CLIENT],
      useFactory: (bale: BaleClient | null) => {
        const registry = new ChannelRegistry();
        registry.register(new StubChannel());
        if (bale) {
          registry.register(new BaleChannel(bale));
          new Logger('ChannelsModule').log('Bale channel enabled');
        }
        return registry;
      },
    },
    ChannelIdentities,
    InboundHandlers,
    UserNotifier,
  ],
  exports: [BALE_CLIENT, ChannelRegistry, ChannelIdentities, InboundHandlers, UserNotifier],
})
export class ChannelsModule {}

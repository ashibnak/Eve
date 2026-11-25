import { Global, Module } from '@nestjs/common';
import { ChannelRegistry } from './channel';
import { StubChannel } from './stub.channel';
import { UserNotifier } from './user-notifier';

@Global()
@Module({
  providers: [
    {
      provide: ChannelRegistry,
      useFactory: () => {
        const registry = new ChannelRegistry();
        registry.register(new StubChannel());
        return registry;
      },
    },
    UserNotifier,
  ],
  exports: [ChannelRegistry, UserNotifier],
})
export class ChannelsModule {}

import { Global, Module } from '@nestjs/common';
import { ChannelRegistry } from './channel';
import { StubChannel } from './stub.channel';

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
  ],
  exports: [ChannelRegistry],
})
export class ChannelsModule {}

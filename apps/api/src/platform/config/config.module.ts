import { Global, Module } from '@nestjs/common';
import { ConfigController } from './config.controller';
import { ConfigService } from './config.service';
import { SettingsRegistry } from './settings';

@Global()
@Module({
  controllers: [ConfigController],
  providers: [SettingsRegistry, ConfigService],
  exports: [SettingsRegistry, ConfigService],
})
export class PlatformConfigModule {}

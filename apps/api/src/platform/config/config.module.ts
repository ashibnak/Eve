import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import { SettingsRegistry } from './settings';

@Global()
@Module({
  providers: [SettingsRegistry, ConfigService],
  exports: [SettingsRegistry, ConfigService],
})
export class PlatformConfigModule {}

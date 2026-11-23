import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { SettingsRegistry } from '../config/settings';
import { HomeJurisdictionSetting, JurisdictionRegistry } from './jurisdiction.registry';

@Global()
@Module({})
export class JurisdictionModule {
  /** Registers the jurisdiction packs this deployment ships (e.g. `ir` in R1). */
  static forRoot(packs: readonly platformV1.JurisdictionPack[]): DynamicModule {
    return {
      module: JurisdictionModule,
      providers: [
        {
          provide: JurisdictionRegistry,
          inject: [SettingsRegistry],
          useFactory: (settings: SettingsRegistry) => {
            settings.register(HomeJurisdictionSetting);
            return new JurisdictionRegistry(packs);
          },
        },
      ],
      exports: [JurisdictionRegistry],
    };
  }
}

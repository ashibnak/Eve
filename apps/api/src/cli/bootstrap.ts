/**
 * First-run setup: sets the customer time zone and creates the first system administrator.
 *
 *   EVE_BOOTSTRAP_PASSWORD=... node dist/cli/bootstrap.js \
 *     --username admin --contact-channel stub --contact-address 09120000000 --time-zone Asia/Tehran
 *
 * The password comes from the environment so it never lands in shell history. Idempotent for the
 * time zone; fails if the user already exists.
 */
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SystemAdminRole } from '../platform/auth/roles';
import { UserService } from '../platform/auth/user.service';
import { ConfigService } from '../platform/config/config.service';
import { TimeZoneSetting } from '../platform/config/settings';
import { newCorrelationId, runWithContext } from '../platform/context/request-context';
import {
  HomeJurisdictionSetting,
  JurisdictionRegistry,
} from '../platform/jurisdiction/jurisdiction.registry';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      username: { type: 'string' },
      'contact-channel': { type: 'string', default: 'stub' },
      'contact-address': { type: 'string' },
      'time-zone': { type: 'string' },
      jurisdiction: { type: 'string' },
    },
  });
  const password = process.env.EVE_BOOTSTRAP_PASSWORD;
  if (!values.username || !values['contact-address'] || !values.jurisdiction || !password) {
    throw new Error(
      'Usage: EVE_BOOTSTRAP_PASSWORD=... bootstrap --jurisdiction <ir> --username <u> --contact-address <a> [--contact-channel stub] [--time-zone Area/City]',
    );
  }

  process.env.EVE_WORKER = 'off';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    await runWithContext(
      {
        actor: { kind: 'system', id: 'cli:bootstrap' },
        source: 'manual',
        correlationId: newCorrelationId(),
        causationId: null,
        requestId: null,
        actionId: null,
      },
      async () => {
        const pack = app.get(JurisdictionRegistry).get(values.jurisdiction as string);
        const config = app.get(ConfigService);
        await config.set({
          setting: TimeZoneSetting,
          companyId: null,
          value: values['time-zone'] ?? pack.defaultTimeZone,
          reason: 'initial setup',
        });
        await config.set({
          setting: HomeJurisdictionSetting,
          companyId: null,
          value: pack.code,
          reason: 'initial setup',
        });
        const users = app.get(UserService);
        const user = await users.create({
          username: values.username as string,
          password,
          contactChannel: values['contact-channel'] as string,
          contactAddress: values['contact-address'] as string,
          reason: 'initial setup: first system administrator',
        });
        await users.grantRole({
          userId: user.id,
          role: SystemAdminRole.name,
          scopeKind: 'customer',
          companyId: null,
          unitId: null,
          reason: 'initial setup: first system administrator',
        });
        console.log(`Created system administrator ${user.username} (${user.id})`);
      },
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

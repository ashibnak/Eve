import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { HttpTestClient } from '../../../../../test/http-client';
import { asUser, uniqueCompanyCode, uniqueUsername } from '../../../../../test/platform';
import { AppModule } from '../../../../app.module';
import { UserService } from '../../../../platform/auth/user.service';
import { ChannelRegistry } from '../../../../platform/channels/channel';
import type { StubChannel } from '../../../../platform/channels/stub.channel';
import { ConfigService } from '../../../../platform/config/config.service';
import { TimeZoneSetting } from '../../../../platform/config/settings';
import { configureApp } from '../../../../platform/http/configure-app';
import { generatePeopleFile } from './people.harness';

const PASSWORD = 'a-long-enough-password';

describe('people over HTTP (real app wiring)', () => {
  let app: INestApplication;
  let base: string;
  let stub: StubChannel;
  const adminName = uniqueUsername('ppl.admin');

  async function login(username: string, address: string): Promise<HttpTestClient> {
    const client = new HttpTestClient(base);
    expect(
      (await client.call('POST', '/auth/login', { username, password: PASSWORD })).status,
    ).toBe(200);
    const code = stub.lastTo(address)?.params.code;
    expect((await client.call('POST', '/auth/code', { code })).status).toBe(200);
    return client;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = inject('db').appUrl;
    process.env.EVE_WORKER = 'off';
    app = await NestFactory.create(AppModule, { logger: ['error'] });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    stub = app.get(ChannelRegistry).get('stub') as StubChannel;
    await asUser(async () => {
      await app
        .get(ConfigService)
        .set({ setting: TimeZoneSetting, companyId: null, value: 'Asia/Tehran', reason: 'setup' });
      const users = app.get(UserService);
      const admin = await users.create({
        username: adminName,
        password: PASSWORD,
        contactChannel: 'stub',
        contactAddress: '09126660000',
        reason: 'setup',
      });
      await users.grantRole({
        userId: admin.id,
        role: 'system_admin',
        scopeKind: 'customer',
        companyId: null,
        unitId: null,
        reason: 'setup',
      });
    });
  });

  afterAll(() => app.close());

  it('serves the people register to its data owner only', async () => {
    const admin = await login(adminName, '09126660000');
    const company = (
      await admin.call('POST', '/platform/companies', {
        code: uniqueCompanyCode('P'),
        jurisdictionCode: 'ir',
        reason: 'people',
      })
    ).body as { id: string };
    const name = uniqueUsername('ppl.owner');
    const created = (
      await admin.call('POST', '/platform/users', {
        username: name,
        password: PASSWORD,
        contactChannel: 'stub',
        contactAddress: '09125557777',
        reason: 'people owner',
      })
    ).body as { id: string };
    await admin.call('POST', `/platform/users/${created.id}/roles`, {
      role: 'people_data_owner',
      scopeKind: 'company',
      companyId: company.id,
      reason: 'people owner',
    });
    const owner = await login(name, '09125557777');

    const { content, people } = await generatePeopleFile(5, 3);
    const uploaded = (
      await owner.upload(
        '/platform/imports',
        {
          target: 'people.person',
          companyId: company.id,
          effectiveDate: '2026-11-22',
          sourceName: 'http',
        },
        { name: 'people.xlsx', content },
      )
    ).body as { id: string; mapping: unknown };
    await owner.call('PUT', `/platform/imports/${uploaded.id}/mapping`, {
      mapping: uploaded.mapping,
    });
    await owner.call('POST', `/platform/imports/${uploaded.id}/validate`);
    await owner.call('GET', `/platform/imports/${uploaded.id}/preview`);
    const committed = await owner.call('POST', `/platform/imports/${uploaded.id}/commit`, {
      reason: 'load',
    });
    expect((committed.body as { status: string }).status).toBe('committed');

    const list = await owner.call('GET', `/people/persons?companyId=${company.id}&asOf=2026-11-22`);
    expect(list.status).toBe(200);
    const persons = list.body as { id: string; personnelCode: string }[];
    expect(persons.map((p) => p.personnelCode).sort()).toEqual(people.map((p) => p.code).sort());

    const first = persons[0]!.id;
    expect(
      (
        await owner.call('POST', `/people/persons/${first}/status`, {
          status: 'terminated',
          validFrom: '2026-12-01',
          reason: 'resigned',
        })
      ).body,
    ).toEqual({ changed: true });
    expect(
      (
        await owner.call('PATCH', `/people/persons/${first}`, {
          changes: { lastNameEn: 'Test' },
          reason: 'latin name',
        })
      ).body,
    ).toEqual({ changed: true });
    expect(
      (
        await owner.call('PATCH', `/people/persons/${first}`, {
          changes: { salary: 1 },
          reason: 'x',
        })
      ).status,
    ).toBe(400);

    // System administrators hold no people data.
    expect((await admin.call('GET', `/people/persons?companyId=${company.id}`)).status).toBe(403);
  });
});

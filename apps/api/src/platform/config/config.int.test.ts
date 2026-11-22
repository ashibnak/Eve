import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import {
  asUser,
  createPlatform,
  ensureTimeZone,
  type Platform,
  uniqueCompanyCode,
} from '../../../test/platform';
import { EventPublisher } from '../events/event-publisher';
import { ConfigService, SettingNotConfiguredError } from './config.service';
import { defineSetting } from './settings';

const SampleLimit = defineSetting({
  key: 'test.sample_limit',
  schema: z.number().int().min(1),
  scope: 'customer_or_company',
  default: 10,
});

const CustomerOnly = defineSetting({
  key: 'test.customer_only',
  schema: z.string(),
  scope: 'customer',
});

const Unset = defineSetting({ key: 'test.unset', schema: z.string(), scope: 'customer' });

describe('config: a sample write (S1 done-when 1)', () => {
  let platform: Platform;
  let companyId: string;

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    platform.settings.register(SampleLimit, CustomerOnly, Unset);
    await ensureTimeZone(platform);
    const { result } = await asUser(() =>
      platform.companies.register({
        code: uniqueCompanyCode(),
        jurisdictionCode: 'ir',
        reason: 'test',
      }),
    );
    companyId = result.id;
  });

  afterAll(() => platform.close());

  it('produces exactly one audit row and one outbox event with the same correlation id', async () => {
    const { correlationId } = await asUser(() =>
      platform.config.set({
        setting: SampleLimit,
        companyId: null,
        value: 25,
        reason: 'raise limit',
      }),
    );

    const audits = await platform.prisma.auditLog.findMany({ where: { correlationId } });
    const outbox = await platform.prisma.eventsOutbox.findMany({ where: { correlationId } });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'platform.config.set',
      entityType: 'config_setting',
      source: 'manual',
      reason: 'raise limit',
      actor: { kind: 'user', id: 'test-admin' },
      after: { key: 'test.sample_limit', value: 25 },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      type: 'platform.config.changed',
      schemaVersion: 1,
      payload: { key: 'test.sample_limit', company_id: null },
      publishedAt: null,
    });
    expect(await platform.config.get(SampleLimit)).toBe(25);
  });

  it('records the previous value as "before" on a change', async () => {
    await asUser(() =>
      platform.config.set({ setting: SampleLimit, companyId: null, value: 30, reason: 'r1' }),
    );
    const { correlationId } = await asUser(() =>
      platform.config.set({ setting: SampleLimit, companyId: null, value: 31, reason: 'r2' }),
    );
    const audit = await platform.prisma.auditLog.findFirstOrThrow({ where: { correlationId } });
    expect(audit.before).toEqual({ key: 'test.sample_limit', value: 30 });
    expect(audit.after).toEqual({ key: 'test.sample_limit', value: 31 });
  });

  it('rolls back the value and the audit row when publishing the event fails', async () => {
    const failing = new EventPublisher(platform.eventRegistry, platform.clock);
    failing.publish = () => Promise.reject(new Error('outbox unavailable'));
    const config = new ConfigService(
      platform.prisma,
      platform.txRunner,
      platform.settings,
      platform.audit,
      failing,
      platform.clock,
      platform.eventRegistry,
    );
    const before = await platform.config.get(SampleLimit);

    const attempt = asUser(() =>
      config.set({ setting: SampleLimit, companyId: null, value: 99, reason: 'will fail' }),
    );
    await expect(attempt).rejects.toThrow('outbox unavailable');

    expect(await platform.config.get(SampleLimit)).toBe(before);
    expect(await platform.prisma.auditLog.count({ where: { reason: 'will fail' } })).toBe(0);
  });

  it('reads company override, then customer value, then default', async () => {
    await asUser(() =>
      platform.config.set({ setting: SampleLimit, companyId: null, value: 40, reason: 'customer' }),
    );
    expect(await platform.config.get(SampleLimit, companyId)).toBe(40);

    await asUser(() =>
      platform.config.set({ setting: SampleLimit, companyId, value: 5, reason: 'company' }),
    );
    expect(await platform.config.get(SampleLimit, companyId)).toBe(5);
    expect(await platform.config.get(SampleLimit)).toBe(40);
  });

  it('fails loudly for a setting without value or default', async () => {
    await expect(platform.config.get(Unset)).rejects.toBeInstanceOf(SettingNotConfiguredError);
  });

  it('rejects invalid values, per-company values for customer settings, and missing reasons', async () => {
    await expect(
      asUser(() =>
        platform.config.set({ setting: SampleLimit, companyId: null, value: 0, reason: 'x' }),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(() =>
        platform.config.set({ setting: CustomerOnly, companyId, value: 'a', reason: 'x' }),
      ),
    ).rejects.toThrow('customer-wide');
    await expect(
      asUser(() =>
        platform.config.set({ setting: CustomerOnly, companyId: null, value: 'a', reason: ' ' }),
      ),
    ).rejects.toThrow('reason');
  });

  it('refuses to write without a request context', async () => {
    await expect(
      platform.config.set({
        setting: CustomerOnly,
        companyId: null,
        value: 'a',
        reason: 'no actor',
      }),
    ).rejects.toThrow('No request context');
  });
});

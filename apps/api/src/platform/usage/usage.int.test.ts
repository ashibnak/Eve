import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { jurisdiction as ir } from '@eve/jurisdiction-ir';
import type { platformV1 } from '@eve/contracts';
import {
  asUser,
  createPlatform,
  ensureHomeJurisdiction,
  ensureTimeZone,
  type Platform,
  uniqueUsername,
} from '../../../test/platform';

/** A Tehran wall-clock time (UTC+03:30 all year since 2022). */
const tehran = (day: string, time: string) => new Date(`${day}T${time}:00+03:30`);

function previousDay(day: platformV1.BusinessDate): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe('usage: counters per Jalali month (customer calendar)', () => {
  let platform: Platform;
  let userA: string;
  let userB: string;
  // A future month nobody else in the test run touches: Farvardin 1410.
  const farvardin = ir.calendar.monthRange(1410, 1);

  async function newUser(): Promise<string> {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('usage'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'usage test',
      }),
    );
    return result.id;
  }

  async function requestAt(instant: Date, userId: string, module: string) {
    platform.clock.setTime(instant);
    await platform.usage.recordRequest(userId, module);
  }

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    await ensureTimeZone(platform);
    await ensureHomeJurisdiction(platform);
    userA = await newUser();
    userB = await newUser();

    // 23:30 on the last day of Esfand 1409 (Tehran) belongs to Esfand...
    await requestAt(tehran(previousDay(farvardin.from), '23:30'), userA, 'platform');
    // ...one hour later it is Farvardin 1410 in Tehran, although still the previous UTC day.
    await requestAt(tehran(farvardin.from, '00:30'), userA, 'platform');
    await requestAt(tehran(farvardin.from, '09:00'), userA, 'platform');
    await requestAt(tehran(farvardin.from, '10:00'), userB, 'org');
    // The last day of Farvardin is still in; the first day of Ordibehesht is not.
    await requestAt(tehran(previousDay(farvardin.to), '23:59'), userB, 'org');
    await requestAt(tehran(farvardin.to, '00:01'), userB, 'org');
    platform.clock.reset();
  });

  afterAll(() => platform.close());

  it('reports a month of the jurisdiction calendar, cut at local midnight', async () => {
    const report = await platform.usage.monthly(1410, 1);
    expect(report).toMatchObject({
      jurisdiction: 'ir',
      calendar: 'persian',
      year: 1410,
      month: 1,
      from: farvardin.from,
      to: farvardin.to,
      activeUsers: 2,
      requests: { platform: 2, org: 2 },
      tokens: {},
    });
  });

  it('puts the late-evening request in the previous month', async () => {
    const esfand = await platform.usage.monthly(1409, 12);
    expect(esfand.requests.platform).toBe(1);
    expect(esfand.activeUsers).toBe(1);
  });

  it('reports nothing for a month without activity', async () => {
    expect(await platform.usage.monthly(1411, 7)).toMatchObject({ activeUsers: 0, requests: {} });
  });
});

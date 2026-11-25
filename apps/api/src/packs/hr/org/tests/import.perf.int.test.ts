import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { platformV1 } from '@eve/contracts';
import { createHr } from '../../../../../test/hr';
import {
  asUser,
  createPlatform,
  ensureTimeZone,
  type Platform,
  uniqueCompanyCode,
  uniqueUsername,
} from '../../../../../test/platform';
import { OrgFixture } from './org.fixture';
import { generateStructure, LEVELS, reviseStructure, structureWorkbook } from './structure-file';

const NOW = new Date('2026-11-22T08:00:00Z');

interface ImportView {
  id: string;
  status: string;
  mapping: unknown;
  findings: { severity: string }[] | null;
  counts: Record<string, number>;
  approvalRequestId: string | null;
}

/**
 * S7 done-when: "import a real company in one working day; the second time under an hour with the
 * saved mapping" (spec §11). The people's part is the structure expert's work on the file; this
 * measures the system's part on an anonymized company of about 6,000 positions.
 */
describe('org structure import at company size (S7 done-when)', () => {
  let platform: Platform;
  let hr: ReturnType<typeof createHr>;
  let companyId: string;
  const users: Record<string, string> = {};
  const timings: Record<string, number> = {};
  let personnelCodes: string[];

  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });
  const run = <T>(user: string, fn: () => Promise<T>) =>
    asUser(fn, as(users[user]!)).then((r) => r.result);
  const timed = async <T>(name: string, fn: () => Promise<T>) => {
    const started = performance.now();
    const result = await fn();
    timings[name] = Math.round(performance.now() - started);
    return result;
  };

  async function user(role: string, company: boolean) {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('impperf'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'perf',
      }),
    );
    await asUser(() =>
      platform.users.grantRole({
        userId: result.id,
        role,
        scopeKind: company ? 'company' : 'customer',
        companyId: company ? companyId : null,
        unitId: null,
        reason: 't',
      }),
    );
    return result.id;
  }

  async function importFile(label: string, content: Buffer, effectiveDate: string) {
    const imp = (await timed(`${label}_upload`, () =>
      run('owner', () =>
        platform.imports.upload({
          target: 'org.structure',
          companyId,
          effectiveDate: effectiveDate as platformV1.BusinessDate,
          sourceName: 'hr-structure-excel',
          fileName: `${label}.xlsx`,
          content,
        }),
      ),
    )) as unknown as ImportView;
    await timed(`${label}_map`, () =>
      run('owner', () => platform.imports.map(imp.id, imp.mapping, true)),
    );
    const validated = (await timed(`${label}_validate`, () =>
      run('owner', () => platform.imports.validate(imp.id)),
    )) as unknown as ImportView;
    expect(validated.findings?.filter((f) => f.severity === 'blocking')).toEqual([]);
    await timed(`${label}_preview`, () => run('owner', () => platform.imports.preview(imp.id)));
    const committed = (await timed(`${label}_commit`, () =>
      run('owner', () => platform.imports.commit(imp.id, `${label} of the structure`)),
    )) as unknown as ImportView;
    return { imp, committed };
  }

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    hr = createHr(platform);
    await ensureTimeZone(platform);
    platform.clock.setTime(NOW);
    companyId = (
      await asUser(() =>
        platform.companies.register({
          code: uniqueCompanyCode('IP'),
          jurisdictionCode: 'ir',
          reason: 't',
        }),
      )
    ).result.id;
    users.admin = await user('system_admin', false);
    users.owner = await user('org_data_owner', true);
    users.approver = await user('org_change_approver', false);
    const prefix = `Q${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
    await run('admin', () =>
      hr.profiles.register(
        companyId,
        {
          nameFa: 'شرکت بزرگ',
          codePrefix: prefix,
          legalFields: { nationalId: '10380284790', ssoWorkshopCode: '1234567890' },
        },
        'setup',
      ),
    );
    await run('admin', () =>
      hr.profiles.setLevels(
        companyId,
        LEVELS.map((nameFa) => ({ nameFa })),
        'levels',
      ),
    );
    const people = new OrgFixture(companyId, prefix);
    for (let i = 0; i < 6100; i++) people.person();
    await people.save(platform);
    personnelCodes = (
      await platform.prisma.peoplePerson.findMany({
        where: { companyId },
        select: { personnelCode: true },
        orderBy: { personnelCode: 'asc' },
      })
    ).map((p) => p.personnelCode);
  }, 300_000);

  afterAll(async () => {
    console.info('org structure import (ms):', JSON.stringify(timings));
    platform.clock.reset();
    await platform.close();
  });

  it(
    'loads ~6,000 positions, then re-imports a revision with the saved mapping',
    { timeout: 1_200_000 },
    async () => {
      const spec = generateStructure({ positions: 6000, personnelCodes, seed: 11 });
      const first = await importFile('first', await structureWorkbook(spec), '2026-11-01');
      expect(first.committed.status).toBe('committed');
      expect(await platform.prisma.orgPositionVersion.count({ where: { companyId } })).toBe(6003);

      const second = await importFile(
        'second',
        await structureWorkbook(reviseStructure(spec), 2),
        '2026-11-20',
      );
      // The saved mapping was used as is.
      expect(second.imp.mapping).toEqual(first.imp.mapping);
      expect(second.committed.status).toBe('awaiting_approval');
      await timed('second_approve_and_apply', () =>
        run('approver', () =>
          platform.approvals.approve(second.committed.approvalRequestId!, null),
        ),
      );
      const total = (label: string) =>
        Object.entries(timings)
          .filter(([k]) => k.startsWith(label))
          .reduce((sum, [, v]) => sum + v, 0);
      timings.first_total = total('first_');
      timings.second_total = total('second_');
      // Far inside "a working day" and "an hour": the time is the people's, not the system's.
      expect(timings.first_total).toBeLessThan(15 * 60_000);
      expect(timings.second_total).toBeLessThan(timings.first_total);
    },
  );
});

import { ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { platformV1 } from '@eve/contracts';
import { createHr } from '../../../../../test/hr';
import {
  asUser,
  createPlatform,
  ensureTimeZone,
  type Platform,
  rawClient,
  uniqueCompanyCode,
  uniqueUsername,
} from '../../../../../test/platform';
import { OrgFixture } from './org.fixture';
import { generateStructure, LEVELS, structureWorkbook } from './structure-file';

const D = (d: string) => d as platformV1.BusinessDate;
const LOADED = D('2026-11-01');
const CHANGED = D('2026-12-02');
const NOW = new Date('2026-11-22T08:00:00Z');

/** Spec §11: "the structure as of date X equals its reconstruction from the audit log". */
describe('org structure rebuilt from the audit log (S10)', () => {
  let platform: Platform;
  let hr: ReturnType<typeof createHr>;
  let companyId: string;
  const users: Record<string, string> = {};
  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });
  const run = <T>(user: string, fn: () => Promise<T>) =>
    asUser(fn, as(users[user]!)).then((r) => r.result);

  async function user(role: string, company: boolean) {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('replay'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'replay test',
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

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    hr = createHr(platform);
    await ensureTimeZone(platform);
    platform.clock.setTime(NOW);
    for (const type of ['org.structure.change', 'org.structure.import.commit']) {
      await asUser(() =>
        platform.config.set({
          setting: platform.approvalTypes.chainSetting(type),
          companyId: null,
          value: ['org_change_approver'],
          reason: 'test chain',
        }),
      );
    }
    companyId = (
      await asUser(() =>
        platform.companies.register({
          code: uniqueCompanyCode('AR'),
          jurisdictionCode: 'ir',
          reason: 't',
        }),
      )
    ).result.id;
    users.admin = await user('system_admin', false);
    users.owner = await user('org_data_owner', true);
    users.approver = await user('org_change_approver', false);
    users.auditor = await user('auditor', false);
    const prefix = `R${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
    await run('admin', () =>
      hr.profiles.register(
        companyId,
        {
          nameFa: 'شرکت بازسازی',
          codePrefix: prefix,
          legalFields: { nationalId: '10380284790', ssoWorkshopCode: '1234567890' },
        },
        'setup',
      ),
    );
    const profile = await run('admin', () =>
      hr.profiles.setLevels(
        companyId,
        LEVELS.map((nameFa) => ({ nameFa })),
        'levels',
      ),
    );
    const people = new OrgFixture(companyId, prefix);
    for (let i = 0; i < 60; i++) people.person();
    await people.save(platform);
    const codes = (
      await platform.prisma.peoplePerson.findMany({
        where: { companyId },
        select: { personnelCode: true },
        orderBy: { personnelCode: 'asc' },
      })
    ).map((p) => p.personnelCode);

    // The structure arrives by import, then changes by a change request and a correction.
    const content = await structureWorkbook(
      generateStructure({ positions: 40, personnelCodes: codes, seed: 3 }),
    );
    const imp = (await run('owner', () =>
      platform.imports.upload({
        target: 'org.structure',
        companyId,
        effectiveDate: LOADED,
        sourceName: 'replay',
        fileName: 'structure.xlsx',
        content,
      }),
    )) as unknown as { id: string; mapping: unknown };
    await run('owner', () => platform.imports.map(imp.id, imp.mapping, true));
    await run('owner', () => platform.imports.validate(imp.id));
    await run('owner', () => platform.imports.preview(imp.id));
    await run('owner', () => platform.imports.commit(imp.id, 'first load'));

    const structure = await run('owner', () => hr.org.getStructure({ companyId, asOf: LOADED }));
    const root = structure.units.find((u) => u.parentUnitId === null)!;
    const top = structure.positions.find((p) => p.reportsToPositionId === null)!;
    const staff = structure.positions.find((p) => !p.supervisory && p.occupancy === 'filled')!;
    const request = await run('owner', () =>
      hr.changeRequests.submit({
        companyId,
        effectiveDate: CHANGED,
        reason: 'new unit',
        operations: [
          {
            op: 'unit.create',
            ref: 'n',
            nameFa: 'واحد تازه',
            levelId: profile.levels[1]!.id,
            parent: { id: root.id },
            supervisor: { ref: 'h' },
          },
          {
            op: 'position.create',
            ref: 'h',
            titleFa: 'رئیس واحد تازه',
            unit: { ref: 'n' },
            type: 'approved',
            fte: 1,
            supervisory: true,
            reportsTo: { id: top.id },
          },
          {
            op: 'position.update',
            positionId: staff.id,
            changes: { unit: { ref: 'n' }, reportsTo: { ref: 'h' } },
          },
        ],
      }),
    );
    await run('approver', () => platform.approvals.approve(request.approvalRequestId, null));
    await run('owner', () =>
      hr.corrections.correctPosition(top.id, {
        versionFrom: LOADED,
        changes: { titleFa: 'مدیرعامل گروه' },
        reason: 'typo',
      }),
    );
  }, 180_000);

  afterAll(async () => {
    platform.clock.reset();
    await platform.close();
  });

  it('matches the live structure before, at and after every change', async () => {
    for (const asOf of [D('2026-10-31'), LOADED, D('2026-11-20'), CHANGED, D('2027-01-01')]) {
      const check = await run('auditor', () => hr.auditReplay.check(companyId, asOf));
      expect(check.gaps).toEqual([]);
      expect(check.differences, asOf).toEqual([]);
      expect(check.same).toBe(true);
    }
    const after = await run('auditor', () => hr.auditReplay.check(companyId, CHANGED));
    const before = await run('auditor', () => hr.auditReplay.check(companyId, LOADED));
    expect(after.units).toBe(before.units + 1);
    expect(after.positions).toBe(before.positions + 1);
    expect(before.positions).toBeGreaterThanOrEqual(40);
  });

  it('notices a version changed in the database behind the log', async () => {
    const owner = await rawClient(inject('db').ownerUrl);
    try {
      await owner.query(
        `UPDATE org_unit_version SET name_fa = 'نام دست‌کاری‌شده' WHERE company_id = $1 AND parent_unit_id IS NULL`,
        [companyId],
      );
    } finally {
      await owner.end();
    }
    const check = await run('auditor', () => hr.auditReplay.check(companyId, CHANGED));
    expect(check.same).toBe(false);
    expect(check.differences.some((d) => d.includes('name'))).toBe(true);
  });

  it('is for auditors: the data owner may not run it', async () => {
    await expect(
      run('owner', () => hr.auditReplay.check(companyId, LOADED)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

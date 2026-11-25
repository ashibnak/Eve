import { ConflictException } from '@nestjs/common';
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
import {
  generateStructure,
  LEVELS,
  reviseStructure,
  type StructureSpec,
  structureWorkbook,
} from './structure-file';

const FIRST_LOAD = '2026-11-01' as platformV1.BusinessDate;
const REVISION = '2026-11-20' as platformV1.BusinessDate;
const NOW = new Date('2026-11-22T08:00:00Z');

interface ImportView {
  id: string;
  status: string;
  mapping: Record<string, { entity: string; columns: Record<string, string> }> | null;
  findings: { severity: string; code: string; message: string }[] | null;
  counts: Record<string, number>;
  approvalRequestId: string | null;
}

/** S7: the structure of a company from the three-sheet Excel template, through the S3 pipeline. */
describe('org structure import (S7)', () => {
  let platform: Platform;
  let hr: ReturnType<typeof createHr>;
  let companyId: string;
  let prefix: string;
  const users: Record<string, string> = {};
  let spec: StructureSpec;
  let personnelCodes: string[];

  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });
  const run = <T>(user: string, fn: () => Promise<T>) =>
    asUser(fn, as(users[user]!)).then((r) => r.result);

  async function user(role: string | null, companyScoped: boolean) {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('imp'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'import test',
      }),
    );
    if (role) {
      await asUser(() =>
        platform.users.grantRole({
          userId: result.id,
          role,
          scopeKind: companyScoped ? 'company' : 'customer',
          companyId: companyScoped ? companyId : null,
          unitId: null,
          reason: 't',
        }),
      );
    }
    return result.id;
  }

  /** Upload → (saved or suggested) mapping → validate → preview, as the data owner. */
  async function stage(content: Buffer, effectiveDate: platformV1.BusinessDate) {
    const uploaded = (await run('owner', () =>
      platform.imports.upload({
        target: 'org.structure',
        companyId,
        effectiveDate,
        sourceName: 'hr-structure-excel',
        fileName: 'structure.xlsx',
        content,
      }),
    )) as unknown as ImportView;
    await run('owner', () => platform.imports.map(uploaded.id, uploaded.mapping, true));
    const validated = (await run('owner', () =>
      platform.imports.validate(uploaded.id),
    )) as unknown as ImportView;
    if (validated.findings?.some((f) => f.severity === 'blocking')) return validated;
    return (await run('owner', () =>
      platform.imports.preview(uploaded.id),
    )) as unknown as ImportView;
  }

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    hr = createHr(platform);
    await ensureTimeZone(platform);
    platform.clock.setTime(NOW);
    await asUser(() =>
      platform.config.set({
        setting: platform.approvalTypes.chainSetting('org.structure.import.commit'),
        companyId: null,
        value: ['org_change_approver'],
        reason: 'test chain',
      }),
    );
    companyId = (
      await asUser(() =>
        platform.companies.register({
          code: uniqueCompanyCode('IM'),
          jurisdictionCode: 'ir',
          reason: 't',
        }),
      )
    ).result.id;
    users.admin = await user('system_admin', false);
    users.owner = await user('org_data_owner', true);
    users.approver = await user('org_change_approver', false);

    prefix = `I${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
    // The system administrator sets the company up (decision 2026-11-25).
    await run('admin', () =>
      hr.profiles.register(
        companyId,
        {
          nameFa: 'شرکت آزمایشی واردات',
          codePrefix: prefix,
          legalFields: { nationalId: '10380284790', ssoWorkshopCode: '1234567890' },
        },
        'company setup',
      ),
    );
    await run('admin', () =>
      hr.profiles.setLevels(
        companyId,
        LEVELS.map((nameFa) => ({ nameFa })),
        'company levels',
      ),
    );
    // The person register (people are imported by their own module; seeded here).
    const people = new OrgFixture(companyId, prefix);
    personnelCodes = Array.from({ length: 330 }, () => people.person());
    await people.save(platform);
    const codes = await platform.prisma.peoplePerson.findMany({
      where: { companyId },
      select: { personnelCode: true },
      orderBy: { personnelCode: 'asc' },
    });
    personnelCodes = codes.map((c) => c.personnelCode);
    spec = generateStructure({ positions: 300, personnelCodes, seed: 5 });
  }, 120_000);

  afterAll(async () => {
    platform.clock.reset();
    await platform.close();
  });

  it(
    'loads a company: preview, direct commit by the data owner, audit and events',
    { timeout: 120_000 },
    async () => {
      const preview = await stage(await structureWorkbook(spec), FIRST_LOAD);
      expect(preview.findings?.filter((f) => f.severity === 'blocking')).toEqual([]);
      expect(
        Object.values(preview.mapping!)
          .map((m) => m.entity)
          .sort(),
      ).toEqual(['assignment', 'position', 'unit']);
      expect(preview.status).toBe('previewed');
      expect(preview.counts).toMatchObject({
        added: spec.units.length + spec.positions.length + 3 + spec.assignments.length,
        changed: 0,
        removed: 0,
      });

      const committed = (await run('owner', () =>
        platform.imports.commit(preview.id, 'first load of the structure'),
      )) as unknown as ImportView;
      expect(committed.status).toBe('committed');

      const structure = await run('owner', () =>
        hr.org.getStructure({ companyId, asOf: FIRST_LOAD }),
      );
      expect(structure.units).toHaveLength(spec.units.length);
      expect(structure.positions).toHaveLength(spec.positions.length + 3);
      expect(structure.positions.filter((p) => p.source === 'proposed')).toHaveLength(3);
      expect(structure.positions.map((p) => p.code)).toContain(`${prefix}-P00001`);
      // Legacy codes are kept, Persian digits normalized.
      expect(structure.units.find((u) => u.legacyCode === 'U2')?.code).toMatch(
        new RegExp(`^${prefix}-U\\d{4}$`),
      );

      // Spec §11: no R1-R3/R15 after the import, and every employed person has a manager.
      const ruleRun = await run('owner', () => hr.rules.runner.runNow(companyId));
      const counts = Object.fromEntries(ruleRun.rules.map((r) => [r.code, r.violations]));
      expect([counts.R1, counts.R2, counts.R3, counts.R15]).toEqual([0, 0, 0, 0]);
      const primaries = await platform.prisma.orgAssignment.findMany({
        where: { companyId, kind: 'primary' },
        select: { personId: true, positionId: true },
      });
      const top = structure.positions.find((p) => p.reportsToPositionId === null)!;
      for (const a of primaries.filter((x) => x.positionId !== top.id)) {
        const manager = await run('owner', () =>
          hr.org.getManager({ personId: a.personId, asOf: FIRST_LOAD }),
        );
        expect(manager, `manager of ${a.personId}`).not.toBeNull();
      }

      const audits = await platform.prisma.auditLog.groupBy({
        by: ['action'],
        where: { companyId, source: 'file', actionId: preview.id },
        _count: true,
      });
      expect(Object.fromEntries(audits.map((a) => [a.action, a._count]))).toMatchObject({
        'org.unit.create': spec.units.length,
        'org.position.create': spec.positions.length + 3,
        'org.assignment.start': spec.assignments.length,
      });
      const events = await platform.prisma.eventsOutbox.groupBy({
        by: ['type'],
        where: { companyId, type: { startsWith: 'org.' } },
        _count: true,
      });
      expect(Object.fromEntries(events.map((e) => [e.type, e._count]))).toMatchObject({
        'org.position.created': spec.positions.length + 3,
        'org.assignment.started': spec.assignments.length,
      });
    },
  );

  it(
    're-imports with the saved mapping: changes previewed, approved, applied',
    { timeout: 120_000 },
    async () => {
      const revised = reviseStructure(spec);
      const preview = await stage(await structureWorkbook(revised, 2), REVISION);
      expect(preview.findings?.filter((f) => f.severity === 'blocking')).toEqual([]);
      expect(preview.counts).toMatchObject({ added: 5, removed: 5 });
      // 5 renamed units + 3 moved positions.
      expect(preview.counts.changed).toBe(8);

      // A structure in use changes only with the approver's decision (decision 2026-11-25).
      const waiting = (await run('owner', () =>
        platform.imports.commit(preview.id, 'reorganization of 20 Aban'),
      )) as unknown as ImportView;
      expect(waiting.status).toBe('awaiting_approval');
      await expect(
        run('owner', () => platform.approvals.approve(waiting.approvalRequestId!, null)),
      ).rejects.toThrow();
      await run('approver', () => platform.approvals.approve(waiting.approvalRequestId!, null));

      const after = await run('owner', () => hr.org.getStructure({ companyId, asOf: REVISION }));
      const before = await run('owner', () => hr.org.getStructure({ companyId, asOf: FIRST_LOAD }));
      expect(after.positions).toHaveLength(before.positions.length);
      const diff = await run('owner', () =>
        hr.org.diffStructure({ companyId, from: FIRST_LOAD, to: REVISION }),
      );
      expect(diff.positions.added).toHaveLength(5);
      expect(diff.positions.removed).toHaveLength(5);
      expect(diff.positions.changed).toHaveLength(3);
      expect(diff.units.changed).toHaveLength(5);

      const changedEvents = await platform.prisma.eventsOutbox.count({
        where: { companyId, type: 'org.position.changed' },
      });
      expect(changedEvents).toBe(3);
      const managerEvents = await platform.prisma.eventsOutbox.count({
        where: {
          companyId,
          type: 'org.manager.changed',
          effectiveAt: new Date(`${REVISION}T00:00:00Z`),
        },
      });
      expect(managerEvents).toBeGreaterThanOrEqual(3);
    },
  );

  it(
    'refuses a file that would break R2 or close a filled position',
    { timeout: 120_000 },
    async () => {
      const broken = reviseStructure(spec);
      // Two staff positions report to each other (a cycle), and a filled position is left out.
      const staff = broken.positions.filter((p) => !p.supervisory).slice(10, 12);
      staff[0]!.reportsTo = staff[1]!.code;
      staff[1]!.reportsTo = staff[0]!.code;
      const assigned = new Set(broken.assignments.map((a) => a.position));
      const filled = broken.positions.find(
        (p) => !p.supervisory && assigned.has(p.code) && !staff.includes(p),
      )!;
      broken.positions = broken.positions.filter((p) => p !== filled);
      broken.assignments = broken.assignments.filter((a) => a.position !== filled.code);
      const result = await stage(
        await structureWorkbook(broken, 3),
        '2026-11-21' as platformV1.BusinessDate,
      );
      const blocking = result.findings!.filter((f) => f.severity === 'blocking').map((f) => f.code);
      expect(blocking).toContain('org.rule.R2');
      expect(blocking).toContain('org.import.remove_filled');
      await expect(
        run('owner', () => platform.imports.commit(result.id, 'try anyway')),
      ).rejects.toBeInstanceOf(ConflictException);
    },
  );

  it('keeps the profile prefix once codes exist, and never removes a level', async () => {
    await expect(
      run('admin', () =>
        hr.profiles.register(
          companyId,
          {
            nameFa: 'شرکت آزمایشی واردات',
            codePrefix: 'ZZ99',
            legalFields: { nationalId: '10380284790', ssoWorkshopCode: '1234567890' },
          },
          'try a new prefix',
        ),
      ),
    ).rejects.toThrow(/fixed/);
    const profile = (await run('admin', () => hr.profiles.get(companyId)))!;
    await expect(
      run('admin', () =>
        hr.profiles.setLevels(
          companyId,
          profile.levels.slice(1).map((l) => ({ id: l.id, nameFa: l.nameFa })),
          'drop one',
        ),
      ),
    ).rejects.toThrow(/never removed/);
    await expect(
      run('owner', () => hr.profiles.setLevels(companyId, [{ nameFa: 'x' }], 'not allowed')),
    ).rejects.toThrow();
    await expect(
      run('admin', () =>
        hr.profiles.register(
          companyId,
          {
            nameFa: 'x',
            codePrefix: prefix,
            legalFields: { nationalId: '10380284791', ssoWorkshopCode: '1234567890' },
          },
          'bad national id',
        ),
      ),
    ).rejects.toThrow(/Legal fields/);
  });
});

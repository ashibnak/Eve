import { ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import {
  asUser,
  createPlatform,
  ensureTimeZone,
  type Platform,
  uniqueCompanyCode,
  uniqueUsername,
} from '../../../test/platform';
import { AuditorRole, Permissions } from '../auth/roles';
import { defineSetting } from '../config/settings';
import { scopedPrisma } from './scoped-prisma';

const Threshold = defineSetting({
  key: 'test.scope_threshold',
  schema: z.number().int(),
  scope: 'customer_or_company',
  default: 0,
});

/** A unit-scoped reader, to show that unit grants fail closed until org implements the port. */
const UnitReaderRole = {
  name: 'test_unit_reader',
  permissions: [Permissions.auditRead],
  allowedScopes: ['unit'] as const,
};

describe('scope: company A cannot read company B (S1 done-when 2)', () => {
  let platform: Platform;
  let companyA: string;
  let companyB: string;
  const users: Record<'a' | 'b' | 'all' | 'unit' | 'admin', string> = {
    a: '',
    b: '',
    all: '',
    unit: '',
    admin: '',
  };

  async function user(): Promise<string> {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('scope'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'scope test',
      }),
    );
    return result.id;
  }

  async function grant(
    userId: string,
    role: string,
    scopeKind: 'customer' | 'company' | 'unit',
    companyId: string | null,
    unitId: string | null = null,
  ) {
    return (
      await asUser(() =>
        platform.users.grantRole({
          userId,
          role,
          scopeKind,
          companyId,
          unitId,
          reason: 'scope test',
        }),
      )
    ).result;
  }

  const actor = (id: string) => ({ kind: 'user' as const, id });

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    platform.settings.register(Threshold);
    platform.roles.register(UnitReaderRole);
    await ensureTimeZone(platform);
    for (const [key, code] of [
      ['A', uniqueCompanyCode('A')],
      ['B', uniqueCompanyCode('B')],
    ] as const) {
      const { result } = await asUser(() =>
        platform.companies.register({ code, jurisdictionCode: 'ir', reason: 'scope test' }),
      );
      if (key === 'A') companyA = result.id;
      else companyB = result.id;
    }
    // Company-level data in both companies: settings and their audit rows.
    for (const companyId of [companyA, companyB]) {
      await asUser(() =>
        platform.config.set({ setting: Threshold, companyId, value: 7, reason: 'company value' }),
      );
    }
    users.a = await user();
    users.b = await user();
    users.all = await user();
    users.unit = await user();
    users.admin = await user();
    await grant(users.a, AuditorRole.name, 'company', companyA);
    await grant(users.b, AuditorRole.name, 'company', companyB);
    await grant(users.all, AuditorRole.name, 'customer', null);
    await grant(
      users.unit,
      UnitReaderRole.name,
      'unit',
      companyA,
      '00000000-0000-4000-8000-000000000001',
    );
    await grant(users.admin, 'system_admin', 'customer', null);
  });

  afterAll(() => platform.close());

  it('resolves each user to exactly their granted companies', async () => {
    const a = await platform.access.scopeFor(actor(users.a), Permissions.auditRead);
    expect(a.customerWide).toBe(false);
    expect([...a.companyIds]).toEqual([companyA]);
    expect(
      (await platform.access.scopeFor(actor(users.all), Permissions.auditRead)).customerWide,
    ).toBe(true);
  });

  it('company A sees only company A audit rows, settings and company record', async () => {
    const scope = await platform.access.scopeFor(actor(users.a), Permissions.auditRead);
    const db = scopedPrisma(platform.prisma, scope);

    const audit = await db.auditLog.findMany({ select: { companyId: true } });
    expect(audit.length).toBeGreaterThan(0);
    expect(new Set(audit.map((r) => r.companyId))).toEqual(new Set([companyA]));
    expect(await db.auditLog.count({ where: { companyId: companyB } })).toBe(0);

    const settings = await db.configSetting.findMany({ where: { key: Threshold.key } });
    expect(settings.map((s) => s.companyId)).toEqual([companyA]);

    const companies = await db.coreCompany.findMany({ select: { id: true } });
    expect(companies).toEqual([{ id: companyA }]);
    expect(await db.coreCompany.findUnique({ where: { id: companyB } })).toBeNull();
  });

  it('company B is symmetric', async () => {
    const db = scopedPrisma(
      platform.prisma,
      await platform.access.scopeFor(actor(users.b), Permissions.auditRead),
    );
    const audit = await db.auditLog.findMany({ select: { companyId: true } });
    expect(new Set(audit.map((r) => r.companyId))).toEqual(new Set([companyB]));
  });

  it('keeps customer-wide rows (no company) to customer-wide scopes', async () => {
    const a = scopedPrisma(
      platform.prisma,
      await platform.access.scopeFor(actor(users.a), Permissions.auditRead),
    );
    const all = scopedPrisma(
      platform.prisma,
      await platform.access.scopeFor(actor(users.all), Permissions.auditRead),
    );
    expect(await a.auditLog.count({ where: { companyId: null } })).toBe(0);
    expect(await all.auditLog.count({ where: { companyId: null } })).toBeGreaterThan(0);
  });

  it('gives the system administrator no audit access', async () => {
    const scope = await platform.access.scopeFor(actor(users.admin), Permissions.auditRead);
    expect(scope.customerWide).toBe(false);
    expect(scope.companyIds.size).toBe(0);
  });

  it('fails closed for a unit grant while no org adapter exists', async () => {
    const scope = await platform.access.scopeFor(actor(users.unit), Permissions.auditRead);
    expect(scope.companyIds.size + scope.unitIds.size).toBe(0);
    await expect(
      asUser(() => platform.access.require(Permissions.auditRead), { actor: actor(users.unit) }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses company B to a company A user and customer-level access to both', async () => {
    const asA = <T>(fn: () => Promise<T>) => asUser(fn, { actor: actor(users.a) });
    await expect(
      asA(() => platform.access.requireFor(Permissions.auditRead, companyA)),
    ).resolves.toBeDefined();
    await expect(
      asA(() => platform.access.requireFor(Permissions.auditRead, companyB)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      asA(() => platform.access.requireFor(Permissions.configRead, null)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('stops access as soon as a grant is revoked', async () => {
    const extra = await user();
    const { id } = await grant(extra, AuditorRole.name, 'company', companyB);
    expect([
      ...(await platform.access.scopeFor(actor(extra), Permissions.auditRead)).companyIds,
    ]).toEqual([companyB]);
    await asUser(() => platform.users.revokeRole(id, 'access ended'));
    expect(
      (await platform.access.scopeFor(actor(extra), Permissions.auditRead)).companyIds.size,
    ).toBe(0);
  });

  it('an agent gets exactly the scope of the user it acts for', async () => {
    const scope = await platform.access.scopeFor(
      { kind: 'agent', id: 'agent:assistant', onBehalfOf: users.a },
      Permissions.auditRead,
    );
    expect([...scope.companyIds]).toEqual([companyA]);
  });

  it('is read-only and limited to registered models', async () => {
    const db = scopedPrisma(
      platform.prisma,
      await platform.access.scopeFor(actor(users.all), Permissions.auditRead),
    );
    await expect(db.configSetting.deleteMany({})).rejects.toThrow('read-only');
    await expect(db.authSession.findMany()).rejects.toThrow('not readable through the scope layer');
  });
});

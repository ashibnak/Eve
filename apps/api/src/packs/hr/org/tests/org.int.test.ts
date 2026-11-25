import { ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { orgV1, type platformV1 } from '@eve/contracts';
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

const D = (d: string) => d as platformV1.BusinessDate;
const ON = D('2026-11-22');
const BEFORE_ACTING = D('2026-01-01');

/**
 * Company A, unit root ⊃ ops ⊃ team:
 *   CEO (ceo) ← VP (vacant; actingVp acting from 2026-06-01) ← Director (dirGone, terminated)
 *   ← Manager (mgr) ← Staff (emp); Staff2 (emp2 until 2026-06-01, then Staff3) ← Director.
 *   Advisor (advisor) ← CEO; Staff ··· dotted ··· Advisor.
 */
describe('org read services (S5 done-when 1: manager resolution)', () => {
  let platform: Platform;
  let hr: ReturnType<typeof createHr>;
  let companyA: string;
  let companyB: string;
  const pos: Record<string, string> = {};
  const per: Record<string, string> = {};
  const unit: Record<string, string> = {};
  const users: Record<string, string> = {};
  let bPosition: string;

  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });
  const run = <T>(user: string, fn: () => Promise<T>) =>
    asUser(fn, as(users[user]!)).then((r) => r.result);

  async function user(role: string | null, companyId: string | null) {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('org'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'org test',
      }),
    );
    if (role) {
      await asUser(() =>
        platform.users.grantRole({
          userId: result.id,
          role,
          scopeKind: companyId ? 'company' : 'customer',
          companyId,
          unitId: null,
          reason: 't',
        }),
      );
    }
    return result.id;
  }

  async function link(userId: string, personId: string, companyId: string) {
    await platform.prisma.peopleUserLink.create({
      data: { userId, personId, companyId, linkedAt: new Date() },
    });
  }

  async function register(prefix: string) {
    return (
      await asUser(() =>
        platform.companies.register({
          code: uniqueCompanyCode(prefix),
          jurisdictionCode: 'ir',
          reason: 't',
        }),
      )
    ).result.id;
  }

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    hr = createHr(platform);
    await ensureTimeZone(platform);
    companyA = await register('OA');
    companyB = await register('OB');

    const a = new OrgFixture(companyA, `A${Date.now().toString(36).toUpperCase()}`.slice(0, 10));
    unit.root = a.unit('مدیریت عامل');
    unit.ops = a.unit('معاونت عملیات', unit.root);
    unit.team = a.unit('تیم پشتیبانی', unit.ops);
    pos.ceo = a.position(unit.root, 'مدیرعامل', { supervisory: true });
    pos.vp = a.position(unit.ops, 'معاون عملیات', { supervisory: true, reportsTo: pos.ceo });
    pos.director = a.position(unit.ops, 'مدیر', { supervisory: true, reportsTo: pos.vp });
    pos.manager = a.position(unit.team, 'سرپرست', { supervisory: true, reportsTo: pos.director });
    pos.staff = a.position(unit.team, 'کارشناس', { reportsTo: pos.manager });
    pos.staff2 = a.position(unit.ops, 'کارشناس ۲', { reportsTo: pos.director });
    pos.staff3 = a.position(unit.ops, 'کارشناس ۳', { reportsTo: pos.director, from: '2026-06-01' });
    pos.advisor = a.position(unit.root, 'مشاور', { supervisory: true, reportsTo: pos.ceo });
    a.line(pos.staff, pos.advisor, 'dotted');

    per.ceo = a.person('active', 'مدیر');
    per.actingVp = a.person('active', 'سرپرست‌موقت');
    per.dirGone = a.person('terminated', 'رفته');
    per.mgr = a.person('active', 'سرپرست');
    per.emp = a.person('active', 'کارمند');
    per.emp2 = a.person('active', 'کارمند۲');
    per.advisor = a.person('active', 'مشاور');
    a.assign(per.ceo, pos.ceo);
    a.assign(per.actingVp, pos.vp, 'acting', { from: '2026-06-01' });
    a.assign(per.dirGone, pos.director);
    a.assign(per.mgr, pos.manager);
    a.assign(per.emp, pos.staff);
    a.assign(per.emp2, pos.staff2, 'primary', { to: '2026-06-01' });
    a.assign(per.emp2, pos.staff3, 'primary', { from: '2026-06-01' });
    a.assign(per.advisor, pos.advisor);
    await a.save(platform);

    const b = new OrgFixture(companyB, `B${Date.now().toString(36).toUpperCase()}`.slice(0, 10));
    const bUnit = b.unit('ریشه');
    bPosition = b.position(bUnit, 'مدیرعامل', { supervisory: true });
    await b.save(platform);

    users.ownerA = await user('org_data_owner', companyA);
    users.auditor = await user('auditor', null);
    users.admin = await user('system_admin', null);
    users.emp = await user(null, null);
    users.mgr = await user(null, null);
    users.actingVp = await user(null, null);
    await link(users.emp, per.emp, companyA);
    await link(users.mgr, per.mgr, companyA);
    await link(users.actingVp, per.actingVp, companyA);
  }, 120_000);

  afterAll(() => platform.close());

  describe('get_manager (spec §3 order)', () => {
    it('is the primary incumbent of the position above', async () => {
      const manager = await run('ownerA', () =>
        hr.org.getManager({ personId: per.emp!, asOf: ON }),
      );
      expect(orgV1.ManagerSchema.parse(manager)).toEqual({
        personId: per.mgr,
        positionId: pos.manager,
        via: 'primary',
        levelsUp: 1,
      });
    });

    it('skips a vacant position (terminated incumbent) and takes an acting incumbent above', async () => {
      expect(
        await run('ownerA', () => hr.org.getManager({ personId: per.mgr!, asOf: ON })),
      ).toEqual({ personId: per.actingVp, positionId: pos.vp, via: 'acting', levelsUp: 2 });
    });

    it('goes further up when the position above is vacant with no acting incumbent', async () => {
      expect(
        await run('ownerA', () => hr.org.getManager({ personId: per.mgr!, asOf: BEFORE_ACTING })),
      ).toEqual({ personId: per.ceo, positionId: pos.ceo, via: 'primary', levelsUp: 3 });
    });

    it('is null at the top of the company', async () => {
      expect(
        await run('ownerA', () => hr.org.getManager({ personId: per.ceo!, asOf: ON })),
      ).toBeNull();
    });

    it('returns n managers up the direct line, never a dotted-line manager', async () => {
      const chain = await run('ownerA', () =>
        hr.org.getApprovalChain({ personId: per.emp!, levels: 5, asOf: ON }),
      );
      expect(chain.map((m) => [m.personId, m.via, m.levelsUp])).toEqual([
        [per.mgr, 'primary', 1],
        [per.actingVp, 'acting', 3],
        [per.ceo, 'primary', 4],
      ]);
      expect(chain.map((m) => m.personId)).not.toContain(per.advisor);
      expect(
        await run('ownerA', () =>
          hr.org.getApprovalChain({ personId: per.emp!, levels: 2, asOf: ON }),
        ),
      ).toHaveLength(2);
    });

    it('informs dotted-line managers only', async () => {
      expect(
        await run('ownerA', () => hr.org.getInformed({ personId: per.emp!, asOf: ON })),
      ).toEqual([{ personId: per.advisor, positionId: pos.advisor, via: 'primary' }]);
      expect(
        await run('ownerA', () => hr.org.getInformed({ personId: per.mgr!, asOf: ON })),
      ).toEqual([]);
    });
  });

  it('answers positions, person positions and teams as of a date', async () => {
    const director = await run('ownerA', () =>
      hr.org.getPosition({ positionId: pos.director!, asOf: ON }),
    );
    expect(orgV1.PositionViewSchema.parse(director)).toMatchObject({
      reportsToPositionId: pos.vp,
      occupancy: 'vacant',
      supervisory: true,
      incumbents: [{ personId: per.dirGone, kind: 'primary', active: false }],
    });
    expect(director!.code).toMatch(/-P00003$/);
    expect(director!.incumbents[0]!.name).toEqual({ first: 'رفته', last: expect.any(String) });

    expect(
      await run('ownerA', () =>
        hr.org.getPersonPosition({ personId: per.emp2!, asOf: BEFORE_ACTING }),
      ),
    ).toEqual([{ positionId: pos.staff2, kind: 'primary', timeShare: 1, validFrom: '2020-01-01' }]);
    expect(
      (await run('ownerA', () => hr.org.getPersonPosition({ personId: per.emp2!, asOf: ON })))[0]
        ?.positionId,
    ).toBe(pos.staff3);

    const direct = await run('ownerA', () =>
      hr.org.getTeam({ positionId: pos.director!, depth: 'direct', asOf: ON }),
    );
    expect(direct.map((m) => m.positionId).sort()).toEqual(
      [pos.manager, pos.staff2, pos.staff3].sort(),
    );
    const subtree = await run('ownerA', () =>
      hr.org.getTeam({ positionId: pos.vp!, depth: 'subtree', asOf: ON }),
    );
    for (const member of subtree) orgV1.TeamMemberSchema.parse(member);
    expect(subtree.find((m) => m.positionId === pos.staff)).toMatchObject({
      depth: 3,
      incumbents: [{ personId: per.emp }],
    });
  });

  it('gives the structure on a date and the differences between two dates', async () => {
    const structure = orgV1.StructureSchema.parse(
      await run('ownerA', () => hr.org.getStructure({ companyId: companyA, asOf: ON })),
    );
    expect(structure.units).toHaveLength(3);
    expect(structure.positions).toHaveLength(8);
    const staff2 = structure.positions.find((p) => p.id === pos.staff2)!;
    expect(staff2).toMatchObject({ occupancy: 'vacant', incumbentCount: 0 });
    expect(structure.positions.find((p) => p.id === pos.vp)).toMatchObject({
      occupancy: 'vacant',
      incumbentCount: 1,
    });

    const diff = orgV1.StructureDiffSchema.parse(
      await run('ownerA', () =>
        hr.org.diffStructure({ companyId: companyA, from: BEFORE_ACTING, to: ON }),
      ),
    );
    expect(diff.positions).toEqual({ added: [pos.staff3], removed: [], changed: [] });
    expect(diff.units).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.moved).toEqual([
      { personId: per.emp2, fromPositionId: pos.staff2, toPositionId: pos.staff3 },
    ]);
  });

  describe('access', () => {
    it('keeps a company org reader to their company; auditors read; admins do not', async () => {
      await expect(
        run('ownerA', () => hr.org.getPosition({ positionId: bPosition })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        run('ownerA', () => hr.org.getStructure({ companyId: companyB })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((await run('auditor', () => hr.org.getPosition({ positionId: bPosition })))?.id).toBe(
        bPosition,
      );
      await expect(
        run('admin', () => hr.org.getStructure({ companyId: companyA })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a linked employee see their own position and managers, nobody else', async () => {
      expect(
        (await run('emp', () => hr.org.getManager({ personId: per.emp!, asOf: ON })))?.personId,
      ).toBe(per.mgr);
      expect(
        await run('emp', () => hr.org.getInformed({ personId: per.emp!, asOf: ON })),
      ).toHaveLength(1);
      await expect(
        run('emp', () => hr.org.getManager({ personId: per.emp2!, asOf: ON })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        run('emp', () => hr.org.getPosition({ positionId: pos.staff! })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // An employee reads no names: the manager's view carries no personal data.
      await expect(
        run('emp', () => hr.people.service.getPerson(per.mgr!, { asOf: ON })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a team lead read their team (org and people), nothing above or beside', async () => {
      const team = await run('mgr', () =>
        hr.org.getTeam({ positionId: pos.manager!, depth: 'subtree', asOf: ON }),
      );
      expect(team).toEqual([
        {
          positionId: pos.staff,
          depth: 1,
          incumbents: [
            expect.objectContaining({ personId: per.emp, active: true, personnelCode: '000005' }),
          ],
        },
      ]);
      await expect(
        run('mgr', () => hr.org.getTeam({ positionId: pos.director!, depth: 'direct', asOf: ON })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        (await run('mgr', () => hr.people.service.getPerson(per.emp!, { asOf: ON })))?.id,
      ).toBe(per.emp);
      await expect(
        run('mgr', () => hr.people.service.getPerson(per.emp2!, { asOf: ON })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        (
          await run('mgr', () =>
            hr.people.service.getMany([per.emp!, per.emp2!, per.ceo!], { asOf: ON }),
          )
        ).map((p) => p.id),
      ).toEqual([per.emp]);
    });

    it('gives an acting supervisor the team of the position they cover, from that date only', async () => {
      const members = await run('actingVp', () =>
        hr.people.service.getMany([per.emp!, per.emp2!, per.mgr!, per.ceo!], { asOf: ON }),
      );
      expect(members.map((p) => p.id).sort()).toEqual([per.emp, per.emp2, per.mgr].sort());
      expect(
        await run('actingVp', () => hr.people.service.getMany([per.emp!], { asOf: BEFORE_ACTING })),
      ).toEqual([]);
    });

    it('answers the platform unit-subtree port, so unit grants see their subtree', async () => {
      expect((await platform.unitSubtree.unitIdsUnder(companyA, unit.ops!, ON)).sort()).toEqual(
        [unit.ops, unit.team].sort(),
      );
      expect(await platform.unitSubtree.unitIdsUnder(companyA, unit.team!, ON)).toEqual([
        unit.team,
      ]);
      expect(await platform.unitSubtree.unitIdsUnder(companyB, unit.ops!, ON)).toEqual([]);
    });
  });

  describe('database constraints', () => {
    it('R15: a supervisory position never has two primary incumbents at once', async () => {
      // Own positions (in company B), so the shared tree above stays as it is.
      const f = new OrgFixture(companyB, `R${Date.now().toString(36).toUpperCase()}`.slice(0, 10));
      const u = f.unit('واحد R15');
      const head = f.position(u, 'رئیس', { supervisory: true });
      const staff = f.position(u, 'کارشناس', { to: '2030-01-01' });
      const other = f.position(u, 'کارشناس دیگر');
      f.assign(f.person(), head);
      f.assign(f.person(), staff);
      const newcomer = f.person();
      await f.save(platform);

      const db = await rawClient(inject('db').appUrl);
      try {
        const assign = (positionId: string, from: string) =>
          db.query(
            `INSERT INTO org_assignment (company_id, person_id, position_id, kind, time_share, source, valid_from, recorded_at)
             VALUES ($1, $2, $3, 'primary', 1, 'import', $4, now())`,
            [companyB, newcomer, positionId, from],
          );
        await expect(assign(head, '2026-01-01')).rejects.toThrow(/R15/);
        // A non-supervisory position may have several primary incumbents...
        await assign(staff, '2026-01-01');
        // ...but it cannot become supervisory while both sit there.
        await expect(
          db.query(
            `INSERT INTO org_position_version (position_id, company_id, title_fa, unit_id, type, fte, supervisory, status, source, valid_from, recorded_at)
             VALUES ($1, $2, 'کارشناس ارشد', $3, 'approved', 1, true, 'active', 'official', '2030-01-01', now())`,
            [staff, companyB, u],
          ),
        ).rejects.toThrow(/R15/);
        // One primary position per person at a time.
        await expect(assign(other, '2026-02-01')).rejects.toThrow(
          /org_assignment_one_primary_per_person/,
        );
        await expect(db.query('DELETE FROM org_assignment')).rejects.toThrow(/permission denied/);
        await expect(db.query(`UPDATE org_assignment SET kind = 'acting'`)).rejects.toThrow(
          /permission denied/,
        );
      } finally {
        await db.end();
      }
    });
  });
});

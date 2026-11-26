import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import { orgV1, type platformV1 } from '@eve/contracts';
import { createHr } from '../../../../../test/hr';
import {
  asUser,
  createPlatform,
  ensureTimeZone,
  type Platform,
  uniqueCompanyCode,
  uniqueUsername,
} from '../../../../../test/platform';
import { defineApprovalRequestType } from '../../../../platform/approvals/request-types';
import { OrgFixture } from './org.fixture';

const D = (d: string) => d as platformV1.BusinessDate;
const TODAY = D('2026-11-22');
const NOW = new Date('2026-11-22T08:00:00Z');
const IN_TEN_DAYS = D('2026-12-02');

/** Stand-in for Module 43's personnel actions (hire, promotion, transfer). */
const TEST_HIRE = 'personnel_action.test.hire';

/**
 * Company: root (CEO) ⊃ ops (HEAD_OPS: STAFF_A a, STAFF_B b, VACANT) · sales (HEAD_SALES: STAFF_C c,
 * DUO d+e) · lab (LAB_HEAD vacant: LAB_STAFF g). f has no position yet.
 */
describe('org writes: change requests, corrections, apply_assignment (S8)', () => {
  let platform: Platform;
  let hr: ReturnType<typeof createHr>;
  let companyId: string;
  let levelId: string;
  const pos: Record<string, string> = {};
  const per: Record<string, string> = {};
  const unit: Record<string, string> = {};
  const users: Record<string, string> = {};

  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });
  const run = <T>(user: string, fn: () => Promise<T>) =>
    asUser(fn, as(users[user]!)).then((r) => r.result);

  async function user(role: string, company: boolean) {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('chg'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'changes test',
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

  const submit = (
    operations: orgV1.ChangeOperation[],
    effectiveDate: platformV1.BusinessDate,
    reason = 'reorganize',
  ) =>
    run('owner', () => hr.changeRequests.submit({ companyId, effectiveDate, reason, operations }));
  const outbox = (type: string) =>
    platform.prisma.eventsOutbox.findMany({ where: { companyId, type }, orderBy: { seq: 'asc' } });

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    hr = createHr(platform);
    await ensureTimeZone(platform);
    platform.clock.setTime(NOW);
    for (const type of ['org.structure.change', TEST_HIRE]) {
      if (type === TEST_HIRE) {
        platform.approvalTypes.register(
          defineApprovalRequestType({
            type: TEST_HIRE,
            payload: z.object({ personId: z.uuid() }),
            defaultChain: ['org_change_approver'],
            apply: async () => {},
          }),
        );
      }
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
          code: uniqueCompanyCode('CH'),
          jurisdictionCode: 'ir',
          reason: 't',
        }),
      )
    ).result.id;
    const f = new OrgFixture(companyId, `C${Date.now().toString(36).toUpperCase()}`.slice(0, 10));
    unit.root = f.unit('مدیریت عامل');
    unit.ops = f.unit('عملیات', unit.root);
    unit.sales = f.unit('فروش', unit.root);
    unit.lab = f.unit('آزمایشگاه', unit.root);
    pos.CEO = f.position(unit.root, 'مدیرعامل', { supervisory: true });
    pos.HEAD_OPS = f.position(unit.ops, 'مدیر عمليات', { supervisory: true, reportsTo: pos.CEO });
    pos.HEAD_SALES = f.position(unit.sales, 'مدیر فروش', { supervisory: true, reportsTo: pos.CEO });
    pos.LAB_HEAD = f.position(unit.lab, 'رئیس آزمایشگاه', {
      supervisory: true,
      reportsTo: pos.CEO,
    });
    f.supervise(unit.root, pos.CEO);
    f.supervise(unit.ops, pos.HEAD_OPS);
    f.supervise(unit.sales, pos.HEAD_SALES);
    f.supervise(unit.lab, pos.LAB_HEAD);
    pos.STAFF_A = f.position(unit.ops, 'کارشناس', { reportsTo: pos.HEAD_OPS });
    pos.STAFF_B = f.position(unit.ops, 'کارشناس', { reportsTo: pos.HEAD_OPS });
    pos.VACANT = f.position(unit.ops, 'کارشناس', { reportsTo: pos.HEAD_OPS });
    pos.STAFF_C = f.position(unit.sales, 'کارشناس', { reportsTo: pos.HEAD_SALES });
    pos.DUO = f.position(unit.sales, 'کارشناس', { reportsTo: pos.HEAD_SALES });
    pos.LAB_STAFF = f.position(unit.lab, 'کارشناس', { reportsTo: pos.LAB_HEAD });
    for (const name of ['ceo', 'hOps', 'hSales', 'a', 'b', 'c', 'd', 'e', 'f', 'g'])
      per[name] = f.person();
    f.assign(per.ceo!, pos.CEO);
    f.assign(per.hOps!, pos.HEAD_OPS);
    f.assign(per.hSales!, pos.HEAD_SALES);
    f.assign(per.a!, pos.STAFF_A);
    f.assign(per.b!, pos.STAFF_B);
    f.assign(per.c!, pos.STAFF_C);
    f.assign(per.d!, pos.DUO);
    f.assign(per.e!, pos.DUO);
    f.assign(per.g!, pos.LAB_STAFF);
    await f.save(platform);

    users.admin = await user('system_admin', false);
    users.owner = await user('org_data_owner', true);
    users.approver = await user('org_change_approver', false);
    const profile = await run('admin', () =>
      hr.profiles.setLevels(companyId, [{ nameFa: 'مدیریت عامل' }, { nameFa: 'معاونت' }], 'levels'),
    );
    levelId = profile.levels[1]!.id;
  }, 120_000);

  afterAll(async () => {
    platform.clock.reset();
    await platform.close();
  });

  it('S8 done-when: request → impact → approval → written now, events on the effective date', async () => {
    const request = await submit(
      [
        {
          op: 'unit.create',
          ref: 'dev',
          nameFa: 'توسعه',
          levelId,
          parent: { id: unit.root! },
          supervisor: { ref: 'devHead' },
        },
        {
          op: 'position.create',
          ref: 'devHead',
          titleFa: 'مدیر توسعه',
          unit: { ref: 'dev' },
          type: 'approved',
          fte: 1,
          supervisory: true,
          reportsTo: { id: pos.CEO! },
        },
        {
          op: 'position.update',
          positionId: pos.STAFF_A!,
          changes: { unit: { ref: 'dev' }, reportsTo: { ref: 'devHead' } },
        },
        {
          op: 'position.update',
          positionId: pos.STAFF_B!,
          changes: { reportsTo: { id: pos.HEAD_SALES! } },
        },
      ],
      IN_TEN_DAYS,
    );
    orgV1.ChangeRequestViewSchema.parse(request);
    // The impact the approver sees (spec §8).
    expect(request.impact.movedPeople).toEqual([
      { personId: per.a, positionId: pos.STAFF_A, fromUnitId: unit.ops, toUnit: 'new-unit:dev' },
    ]);
    expect(request.impact.ordersNeeded).toBe(1);
    expect(request.impact.managerChanges).toEqual(
      expect.arrayContaining([
        { personId: per.a, from: per.hOps, to: per.ceo },
        { personId: per.b, from: per.hOps, to: per.hSales },
      ]),
    );
    expect(request.impact.warnings.opened).toContainEqual({
      code: 'R5',
      subject: `position:${pos.STAFF_B}`,
      key: 'manager_outside_unit_line',
    });

    // Four eyes: the requester cannot approve; the structure-change approver does.
    await expect(
      run('owner', () => platform.approvals.approve(request.approvalRequestId, null)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const { correlationId } = await asUser(
      () => platform.approvals.approve(request.approvalRequestId, null),
      as(users.approver!),
    );
    expect((await run('owner', () => hr.changeRequests.get(request.id)))?.status).toBe('applied');

    // Written now, effective from the date: today's structure is unchanged.
    const later = await run('owner', () => hr.org.getStructure({ companyId, asOf: IN_TEN_DAYS }));
    const today = await run('owner', () => hr.org.getStructure({ companyId, asOf: TODAY }));
    const dev = later.units.find((u) => u.name.fa === 'توسعه')!;
    expect(dev.code).toMatch(/-U\d{4}$/);
    expect(dev.supervisorPositionId).not.toBeNull();
    expect(later.positions.find((p) => p.id === pos.STAFF_A)?.unitId).toBe(dev.id);
    expect(today.positions.find((p) => p.id === pos.STAFF_A)?.unitId).toBe(unit.ops);
    expect(today.units.some((u) => u.name.fa === 'توسعه')).toBe(false);

    // Events wait for the effective date (spec §7).
    expect(await outbox('org.change_request.approved')).toHaveLength(0);
    platform.clock.setTime(new Date(`${IN_TEN_DAYS}T08:00:00Z`));
    try {
      // Other test files may leave events due the same day; this company's five are checked below.
      expect(await hr.eventSink.publishDue()).toBeGreaterThanOrEqual(5);
    } finally {
      platform.clock.setTime(NOW);
    }
    const published = await platform.prisma.eventsOutbox.findMany({
      where: {
        companyId,
        type: { startsWith: 'org.' },
        effectiveAt: new Date(`${IN_TEN_DAYS}T00:00:00Z`),
      },
    });
    expect(published.map((e) => e.type).sort()).toEqual([
      'org.change_request.approved',
      'org.manager.changed',
      'org.manager.changed',
      'org.position.changed',
      'org.position.created',
    ]);
    // Same flow as the approval that applied it.
    expect(new Set(published.map((e) => e.correlationId))).toEqual(new Set([correlationId]));
    expect(await hr.eventSink.publishDue()).toBe(0);
  });

  it('adds the special system_admin step when more than 30 days back (R4)', async () => {
    const request = await submit(
      [{ op: 'position.update', positionId: pos.VACANT!, changes: { titleFa: 'کارشناس ارشد' } }],
      D('2026-10-13'),
    );
    const approval = await run('owner', () => platform.approvals.get(request.approvalRequestId));
    expect(approval.chain).toEqual(['org_change_approver', 'system_admin']);
    await run('approver', () => platform.approvals.approve(request.approvalRequestId, null));
    expect((await run('owner', () => hr.changeRequests.get(request.id)))?.status).toBe('submitted');
    await run('admin', () => platform.approvals.approve(request.approvalRequestId, null));
    expect((await run('owner', () => hr.changeRequests.get(request.id)))?.status).toBe('applied');
    const position = await run('owner', () =>
      hr.org.getPosition({ positionId: pos.VACANT!, asOf: D('2026-10-13') }),
    );
    expect(position?.title.fa).toBe('کارشناس ارشد');
  });

  it('refuses closing a filled position and changes that break blocking rules', async () => {
    await expect(
      submit([{ op: 'position.close', positionId: pos.STAFF_C! }], IN_TEN_DAYS),
    ).rejects.toBeInstanceOf(BadRequestException);
    // HEAD_SALES ↔ STAFF_C would report to each other: R2.
    await expect(
      submit(
        [
          {
            op: 'position.update',
            positionId: pos.HEAD_SALES!,
            changes: { reportsTo: { id: pos.STAFF_C! } },
          },
        ],
        IN_TEN_DAYS,
      ),
    ).rejects.toThrow(/R2/);
    await expect(
      submit(
        [{ op: 'unit.update', unitId: unit.sales!, changes: { parent: { id: unit.sales! } } }],
        IN_TEN_DAYS,
      ),
    ).rejects.toThrow(/R1/);
    // A unit closed while a position still sits in it.
    await expect(submit([{ op: 'unit.close', unitId: unit.lab! }], IN_TEN_DAYS)).rejects.toThrow(
      /closed/,
    );
  });

  it('a returned request is edited, resubmitted and approved', async () => {
    const request = await submit(
      [{ op: 'unit.update', unitId: unit.sales!, changes: { nameFa: 'فروش و بازاریابی' } }],
      IN_TEN_DAYS,
    );
    await run('approver', () =>
      platform.approvals.returnToRequester(request.approvalRequestId, 'name it بازرگانی'),
    );
    const resubmitted = await run('owner', () =>
      hr.changeRequests.resubmit(
        request.id,
        {
          effectiveDate: IN_TEN_DAYS,
          reason: 'reorganize',
          operations: [{ op: 'unit.update', unitId: unit.sales!, changes: { nameFa: 'بازرگانی' } }],
        },
        'renamed as asked',
      ),
    );
    expect(resubmitted.operations).toEqual([
      { op: 'unit.update', unitId: unit.sales, changes: { nameFa: 'بازرگانی' } },
    ]);
    await run('approver', () => platform.approvals.approve(request.approvalRequestId, null));
    const structure = await run('owner', () =>
      hr.org.getStructure({ companyId, asOf: IN_TEN_DAYS }),
    );
    expect(structure.units.find((u) => u.id === unit.sales)?.name.fa).toBe('بازرگانی');
  });

  it('corrects a wrong entry in place for its whole period, audited; structure is not a correction', async () => {
    await run('owner', () =>
      hr.corrections.correctPosition(pos.HEAD_OPS!, {
        versionFrom: D('2020-01-01'),
        changes: { titleFa: 'مدیر عملیات' },
        reason: 'Arabic yeh typed by mistake',
      }),
    );
    const early = await run('owner', () =>
      hr.org.getPosition({ positionId: pos.HEAD_OPS!, asOf: D('2021-06-01') }),
    );
    expect(early?.title.fa).toBe('مدیر عملیات');
    const audit = await platform.prisma.auditLog.findFirst({
      where: { entityId: pos.HEAD_OPS!, action: 'org.position.correct' },
    });
    expect(audit).toMatchObject({
      before: { versionFrom: '2020-01-01', titleFa: 'مدیر عمليات' },
      after: { versionFrom: '2020-01-01', titleFa: 'مدیر عملیات' },
      reason: 'Arabic yeh typed by mistake',
    });
    expect(
      orgV1.PositionCorrectionSchema.safeParse({
        versionFrom: '2020-01-01',
        changes: { unitId: unit.sales },
        reason: 'x',
      }).success,
    ).toBe(false);
    // DUO has two primary incumbents: it cannot become supervisory (R15).
    await expect(
      run('owner', () =>
        hr.corrections.correctPosition(pos.DUO!, {
          versionFrom: D('2020-01-01'),
          changes: { supervisory: true },
          reason: 'x',
        }),
      ),
    ).rejects.toThrow(/R15/);
  });

  describe('apply_assignment', () => {
    let hire: string;

    beforeAll(async () => {
      const request = await run('owner', () =>
        platform.approvals.submit({
          type: TEST_HIRE,
          companyId,
          payload: { personId: per.f! },
          reason: 'hire f',
        }),
      );
      await run('approver', () => platform.approvals.approve(request.id, null));
      hire = request.id;
    });

    const command = (
      overrides: Partial<orgV1.ApplyAssignmentCommand> = {},
    ): orgV1.ApplyAssignmentCommand => ({
      actionId: 'PA-1',
      approvalId: hire,
      companyId,
      operation: 'start',
      personId: per.f!,
      positionId: pos.LAB_HEAD!,
      kind: 'primary',
      effectiveDate: TODAY,
      orderNumber: '1405-77',
      ...overrides,
    });

    it('applies once: the replay writes nothing and publishes nothing', async () => {
      // The personnel action's flow: its correlation id travels with the events (spec §7).
      const workflow = {
        actor: { kind: 'system' as const, id: 'personnel_action' },
        source: 'workflow' as const,
      };
      const { result: first, correlationId } = await asUser(
        () => hr.applyAssignment.apply(command()),
        workflow,
      );
      expect(first.replayed).toBe(false);
      const started = await outbox('org.assignment.started');
      const mine = started.filter(
        (e) => (e.payload as { action_ref: string }).action_ref === 'PA-1',
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]!.correlationId).toBe(correlationId);
      // g's manager was the CEO (the lab head was vacant); now it is f. f now has a manager too.
      const managerEvents = (await outbox('org.manager.changed')).filter(
        (e) => e.correlationId === correlationId,
      );
      expect(managerEvents.map((e) => e.payload)).toEqual(
        expect.arrayContaining([
          { person_id: per.g, from_manager_person_id: per.ceo, to_manager_person_id: per.f },
          { person_id: per.f, from_manager_person_id: null, to_manager_person_id: per.ceo },
        ]),
      );
      expect(managerEvents).toHaveLength(2);

      const { result: again } = await asUser(() => hr.applyAssignment.apply(command()), workflow);
      expect(again).toEqual({ assignmentId: first.assignmentId, replayed: true });
      expect(await platform.prisma.orgAssignment.count({ where: { actionRef: 'PA-1' } })).toBe(1);
      expect((await outbox('org.assignment.started')).length).toBe(started.length);
      await expect(
        asUser(() => hr.applyAssignment.apply(command({ positionId: pos.VACANT! })), workflow),
      ).rejects.toThrow(/different command/);
      expect(
        (await run('owner', () => hr.org.getManager({ personId: per.g!, asOf: TODAY })))?.personId,
      ).toBe(per.f);
    });

    it('refuses without an approved personnel action, and on R3, R4 and R15', async () => {
      const workflow = { actor: { kind: 'system' as const, id: 'personnel_action' } };
      const structure = await run('owner', () =>
        hr.changeRequests.submit({
          companyId,
          effectiveDate: IN_TEN_DAYS,
          reason: 'x',
          operations: [
            { op: 'position.update', positionId: pos.DUO!, changes: { titleFa: 'کارشناس فروش' } },
          ],
        }),
      );
      await expect(
        asUser(
          () =>
            hr.applyAssignment.apply(
              command({ actionId: 'PA-2', approvalId: structure.approvalRequestId }),
            ),
          workflow,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const pending = await run('owner', () =>
        platform.approvals.submit({
          type: TEST_HIRE,
          companyId,
          payload: { personId: per.f! },
          reason: 'x',
        }),
      );
      await expect(
        asUser(
          () => hr.applyAssignment.apply(command({ actionId: 'PA-3', approvalId: pending.id })),
          workflow,
        ),
      ).rejects.toThrow(/not approved/);
      await expect(
        asUser(
          () =>
            hr.applyAssignment.apply(
              command({
                actionId: 'PA-4',
                effectiveDate: D('2026-10-01'),
                positionId: pos.VACANT!,
              }),
            ),
          workflow,
        ),
      ).rejects.toThrow(/R4/);
      // HEAD_SALES already has a primary incumbent.
      await expect(
        asUser(
          () =>
            hr.applyAssignment.apply(
              command({
                actionId: 'PA-5',
                personId: per.c!,
                positionId: pos.HEAD_SALES!,
                kind: 'acting',
              }),
            ),
          workflow,
        ),
      ).resolves.toMatchObject({ result: { replayed: false } });
      await expect(
        asUser(
          () =>
            hr.applyAssignment.apply(
              command({
                actionId: 'PA-6',
                personId: per.d!,
                positionId: pos.HEAD_SALES!,
                kind: 'project',
                timeShare: 0.5,
              }),
            ),
          workflow,
        ),
      ).rejects.toThrow(/R3/);
      await expect(
        asUser(
          () =>
            hr.applyAssignment.apply(
              command({
                actionId: 'PA-7',
                personId: per.g!,
                positionId: pos.HEAD_SALES!,
                kind: 'primary',
              }),
            ),
          workflow,
        ),
      ).rejects.toThrow(/R15/);
      expect(
        await platform.prisma.orgAppliedAction.count({
          where: { actionId: { in: ['PA-2', 'PA-3', 'PA-4', 'PA-6', 'PA-7'] } },
        }),
      ).toBe(0);
    });

    it('ends an assignment: org.assignment.ended, on the effective date', async () => {
      const workflow = { actor: { kind: 'system' as const, id: 'personnel_action' } };
      const end = (actionId: string, effectiveDate: platformV1.BusinessDate) =>
        asUser(
          () =>
            hr.applyAssignment.apply(
              command({
                actionId,
                operation: 'end',
                personId: per.c!,
                positionId: pos.HEAD_SALES!,
                kind: 'acting',
                effectiveDate,
              }),
            ),
          workflow,
        );
      // c's acting started today: it cannot also end today.
      await expect(end('PA-8', TODAY)).rejects.toThrow(/cannot end/);
      const { result } = await end('PA-9', IN_TEN_DAYS);
      expect(result.replayed).toBe(false);
      const waiting = await platform.prisma.orgPendingEvent.findMany({
        where: { companyId, type: 'org.assignment.ended', publishedAt: null },
      });
      expect(waiting.map((e) => (e.payload as { action_ref: string }).action_ref)).toEqual([
        'PA-9',
      ]);
      expect(
        (
          await run('owner', () =>
            hr.org.getPersonPosition({ personId: per.c!, asOf: IN_TEN_DAYS }),
          )
        ).map((p) => p.kind),
      ).toEqual(['primary']);
    });
  });

  it('keeps the BadRequest/Conflict split: invalid bundles are 400, rule breaks 409', async () => {
    await expect(
      submit([{ op: 'unit.close', unitId: '00000000-0000-4000-8000-000000000000' }], IN_TEN_DAYS),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      submit(
        [
          {
            op: 'position.update',
            positionId: pos.HEAD_SALES!,
            changes: { reportsTo: { id: pos.STAFF_C! } },
          },
        ],
        IN_TEN_DAYS,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

import { ConflictException, ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
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
import type { OrgSnapshot } from '../rules/index';
import { OrgFixture } from './org.fixture';

const ON = '2026-11-22' as platformV1.BusinessDate;
const RUN_AT = new Date('2026-11-22T08:00:00Z');

/**
 * Company A has one case of every nightly rule the database lets exist (R15 and two primaries
 * per person are refused by the database itself; they are covered by the blocking check below).
 *   units: root (CEO) ⊃ ops (HEAD_OPS) ⊃ team (no supervisor); root ⊃ sales (HEAD_SALES);
 *          root ⊃ frozenUnit (only a frozen position); loose (a second root)
 */
describe('org rules and findings (S6 done-when)', () => {
  let platform: Platform;
  let hr: ReturnType<typeof createHr>;
  let companyA: string;
  let companyB: string;
  const pos: Record<string, string> = {};
  const per: Record<string, string> = {};
  const unit: Record<string, string> = {};
  const users: Record<string, string> = {};
  let fixture: OrgFixture;

  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });
  const run = <T>(user: string, fn: () => Promise<T>) =>
    asUser(fn, as(users[user]!)).then((r) => r.result);
  const runRules = () => run('ownerA', () => hr.rules.runner.runNow(companyA));
  const inbox = (input: Partial<orgV1.OrgToolInput<'listFindings'>> = {}) =>
    run('ownerA', () => hr.rules.findings.list({ companyId: companyA, ...input }));
  const label = (f: orgV1.FindingView) => {
    const name = Object.entries({ ...pos, ...per, ...unit }).find(
      ([, id]) => id === f.subject.id,
    )?.[0];
    return `${f.code}:${name ?? f.subject.id}:${f.key}`;
  };

  async function user(role: string | null, companyId: string | null) {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('find'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'findings test',
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

  /** Proposes company parameters for an org rule as the admin; the rule approver approves them. */
  async function changeParams(templateId: string, params: unknown): Promise<void> {
    const { result: request } = await asUser(
      () =>
        platform.approvals.submit({
          type: 'platform.rule_params.change',
          companyId: companyA,
          payload: { templateId, templateVersion: 1, params, validFrom: ON },
          reason: 'tune an org rule',
        }),
      as(users.admin!),
    );
    await asUser(() => platform.approvals.approve(request.id, null), as(users.approver!));
  }

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    hr = createHr(platform);
    await ensureTimeZone(platform);
    platform.clock.setTime(RUN_AT);
    await asUser(() =>
      platform.config.set({
        setting: platform.approvalTypes.chainSetting('platform.rule_params.change'),
        companyId: null,
        value: ['rule_approver'],
        reason: 'test chain',
      }),
    );
    const register = async (prefix: string) =>
      (
        await asUser(() =>
          platform.companies.register({
            code: uniqueCompanyCode(prefix),
            jurisdictionCode: 'ir',
            reason: 't',
          }),
        )
      ).result.id;
    companyA = await register('FA');
    companyB = await register('FB');

    const f = new OrgFixture(companyA, `F${Date.now().toString(36).toUpperCase()}`.slice(0, 10));
    fixture = f;
    unit.root = f.unit('مدیریت عامل');
    unit.ops = f.unit('معاونت عملیات', unit.root);
    unit.team = f.unit('تیم فنی', unit.ops);
    unit.sales = f.unit('فروش', unit.root);
    unit.frozenUnit = f.unit('واحد منجمد', unit.root);
    unit.loose = f.unit('واحد سرگردان');
    pos.CEO = f.position(unit.root, 'مدیرعامل', { supervisory: true });
    pos.HEAD_OPS = f.position(unit.ops, 'مدیر عملیات', { supervisory: true, reportsTo: pos.CEO });
    pos.HEAD_SALES = f.position(unit.sales, 'مدیر فروش', { supervisory: true, reportsTo: pos.CEO });
    f.supervise(unit.root, pos.CEO);
    f.supervise(unit.ops, pos.HEAD_OPS);
    f.supervise(unit.sales, pos.HEAD_SALES);
    pos.STAFF1 = f.position(unit.team, 'کارشناس', { reportsTo: pos.HEAD_OPS });
    pos.STAFF2 = f.position(unit.team, 'کارشناس', { reportsTo: pos.HEAD_OPS });
    pos.CROSS = f.position(unit.ops, 'کارشناس', { reportsTo: pos.HEAD_SALES });
    pos.TITLE = f.position(unit.team, 'سرپرست فنی', { reportsTo: pos.HEAD_OPS });
    pos.GONE = f.position(unit.team, 'کارشناس', { reportsTo: pos.HEAD_OPS });
    pos.VACANT = f.position(unit.team, 'کارشناس', { reportsTo: pos.HEAD_OPS });
    pos.PROPOSED = f.position(unit.team, 'کارشناس داده', {
      reportsTo: pos.HEAD_OPS,
      source: 'proposed',
      from: '2026-09-01',
    });
    pos.FROZEN = f.position(unit.frozenUnit, 'کارشناس', { reportsTo: pos.CEO, status: 'frozen' });
    pos.ORPHAN = f.position(unit.team, 'کارشناس');
    for (const name of ['ceo', 'hOps', 'hSales', 's1', 's2', 's3', 's4', 's6'])
      per[name] = f.person();
    per.gone = f.person('terminated');
    f.assign(per.ceo!, pos.CEO);
    f.assign(per.hOps!, pos.HEAD_OPS);
    f.assign(per.hSales!, pos.HEAD_SALES);
    f.assign(per.s1!, pos.STAFF1);
    f.assign(per.s1!, pos.STAFF2, 'project', { from: '2026-01-01' });
    f.assign(per.s2!, pos.STAFF2);
    f.assign(per.s3!, pos.CROSS);
    f.assign(per.s4!, pos.TITLE);
    f.assign(per.gone!, pos.GONE);
    f.assign(per.s6!, pos.FROZEN);
    await f.save(platform);
    // The fixture gives every share 1; s1's project share makes R3 fail (1 + 1 > 1).

    const b = new OrgFixture(companyB, `G${Date.now().toString(36).toUpperCase()}`.slice(0, 10));
    const bRoot = b.unit('ریشه');
    const bTop = b.position(bRoot, 'مدیرعامل', { supervisory: true });
    b.supervise(bRoot, bTop);
    b.position(bRoot, 'کارشناس'); // a second top position: R2 (and the CEO has no reports: R11)
    await b.save(platform);

    users.ownerA = await user('org_data_owner', companyA);
    users.ownerB = await user('org_data_owner', companyB);
    users.auditor = await user('auditor', null);
    users.admin = await user('system_admin', null);
    users.approver = await user('rule_approver', null);
    await asUser(() => hr.rules.runner.runNightly());
  }, 120_000);

  afterAll(async () => {
    platform.clock.reset();
    await platform.close();
  });

  it('the nightly run opens one finding per case, recording rule and parameter versions', async () => {
    const all = await inbox({ severity: undefined, limit: 5000 });
    const info = await inbox({ severity: 'info' });
    expect(all.map(label).sort()).toEqual(
      [
        'R1:root:extra_root',
        'R1:loose:extra_root',
        'R2:CEO:extra_top',
        'R2:ORPHAN:extra_top',
        'R3:s1:over_share',
        'R5:CROSS:manager_outside_unit_line',
        'R6:team:no_supervisor',
        'R6:frozenUnit:no_supervisor',
        'R6:loose:no_supervisor',
        `R7:gone:inactive_on:${pos.GONE}:primary`,
        'R10:frozenUnit:no_active_position',
        'R10:loose:no_active_position',
        'R10:PROPOSED:proposal_unconfirmed',
        'R11:TITLE:title_not_supervisory',
      ].sort(),
    );
    // Info findings are for reports, not the inbox (decision 2026-11-25).
    expect(info.map(label).sort()).toEqual(
      [
        'R12:VACANT:long_vacancy',
        'R12:ORPHAN:long_vacancy',
        'R13:HEAD_SALES:too_few_reports',
      ].sort(),
    );
    for (const finding of [...all, ...info]) {
      orgV1.FindingViewSchema.parse(finding);
      expect(finding).toMatchObject({ status: 'open', rule: { version: 1 }, paramVersionId: null });
    }
    expect(all.find((f) => f.code === 'R3')?.detail).toEqual({ total: 2, maxShare: 1 });
    // Blocking first.
    expect(all.slice(0, 5).every((f) => f.severity === 'blocking')).toBe(true);

    const latest = orgV1.RuleRunViewSchema.parse(
      await run('ownerA', () => hr.rules.findings.latestRun(companyA)),
    );
    expect(latest).toMatchObject({ trigger: 'nightly', asOf: ON, opened: 17, resolved: 0 });
    expect(latest.rules.map((r) => r.code)).toEqual([
      'R1',
      'R2',
      'R3',
      'R15',
      'R5',
      'R6',
      'R7',
      'R10',
      'R11',
      'R12',
      'R13',
      'R14',
    ]);

    // One audit row per opened finding, written by the system actor as a workflow.
    const audits = await platform.prisma.auditLog.findMany({
      where: { companyId: companyA, action: 'org.finding.open' },
    });
    expect(audits).toHaveLength(17);
    expect(audits[0]).toMatchObject({
      actor: { kind: 'system', id: 'org:rules' },
      source: 'workflow',
    });
  });

  it('keeps open findings open, resolves fixed ones, and opens a new one when a case returns', async () => {
    const again = await runRules();
    expect(again).toMatchObject({ trigger: 'manual', opened: 0, resolved: 0, stillOpen: 17 });

    // The data owner ends the terminated person's assignment: R7 resolves.
    const assignment = await platform.prisma.orgAssignment.findFirst({
      where: { personId: per.gone!, positionId: pos.GONE! },
    });
    await platform.prisma.orgAssignment.update({
      where: { id: assignment!.id },
      data: { validTo: new Date('2026-11-01T00:00:00Z') },
    });
    const fixed = await runRules();
    expect(fixed).toMatchObject({ opened: 0, resolved: 1, stillOpen: 16 });
    const resolved = await inbox({ status: 'resolved', code: 'R7' });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.resolvedAt).not.toBeNull();

    // The same person is put back on the position: a new finding, the resolved one stays history.
    fixture.assign(per.gone!, pos.GONE!, 'primary', { from: '2026-11-10' });
    await fixture.save(platform);
    expect(await runRules()).toMatchObject({ opened: 1, resolved: 0 });
    const r7 = await inbox({ code: 'R7' });
    expect(r7).toHaveLength(1);
    expect(r7[0]!.id).not.toBe(resolved[0]!.id);
  });

  it('holds an accepted exception across runs and parameter changes until it is reopened', async () => {
    const [r11] = await inbox({ code: 'R11' });
    const accepted = await run('ownerA', () =>
      hr.rules.commands.accept(r11!.id, 'title kept by board decision'),
    );
    expect(accepted.status).toBe('accepted');
    expect(accepted.accepted).toMatchObject({
      by: users.ownerA,
      reason: 'title kept by board decision',
    });

    // New customer parameters for R11 (still matching) and a stricter R14 for company A.
    await changeParams('org.managerial_title', { words: ['سرپرست', 'مدیر', 'مسئول'] });
    await changeParams('org.max_layers', { layers: 2 });
    const tuned = await runRules();
    expect(tuned.accepted).toBe(1);
    expect(tuned.rules.find((r) => r.code === 'R11')?.paramVersionId).not.toBeNull();
    expect((await inbox({ status: 'accepted' })).map(label)).toEqual([
      'R11:TITLE:title_not_supervisory',
    ]);
    const [r14] = await inbox({ severity: 'info', code: 'R14' });
    expect(r14).toMatchObject({
      subject: { type: 'company', id: companyA },
      detail: { layers: 3 },
    });
    expect(r14!.paramVersionId).not.toBeNull();
    // The case is the rule id + subject + key, never the version: a new template version keeps it.
    const row = await platform.prisma.orgFinding.findUnique({ where: { id: r11!.id } });
    expect(row!.fingerprint).toBe(
      `org.managerial_title|position|${pos.TITLE}|title_not_supervisory`,
    );

    const reopened = await run('ownerA', () =>
      hr.rules.commands.reopen(r11!.id, 'board changed its mind'),
    );
    expect(reopened.status).toBe('open');
    await expect(
      run('ownerA', () => hr.rules.commands.reopen(r11!.id, 'again')),
    ).rejects.toBeInstanceOf(ConflictException);
    const audits = await platform.prisma.auditLog.findMany({
      where: { entityId: r11!.id, action: { in: ['org.finding.accept', 'org.finding.reopen'] } },
      orderBy: { seq: 'asc' },
    });
    expect(audits.map((a) => [a.action, a.reason, (a.actor as { id: string }).id])).toEqual([
      ['org.finding.accept', 'title kept by board decision', users.ownerA],
      ['org.finding.reopen', 'board changed its mind', users.ownerA],
    ]);
  });

  it('accepts warnings only: blocking findings must be fixed, info needs nothing', async () => {
    const [blocking] = await inbox({ severity: 'blocking' });
    const [info] = await inbox({ severity: 'info' });
    await expect(run('ownerA', () => hr.rules.commands.accept(blocking!.id, 'x'))).rejects.toThrow(
      /must be fixed/,
    );
    await expect(run('ownerA', () => hr.rules.commands.accept(info!.id, 'x'))).rejects.toThrow(
      /needs no action/,
    );
  });

  it("keeps each company's findings to its own data owner; auditors read, admins do not", async () => {
    await expect(
      run('ownerB', () => hr.rules.findings.list({ companyId: companyA })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const [aFinding] = await inbox({ code: 'R5' });
    await expect(
      run('ownerB', () => hr.rules.commands.accept(aFinding!.id, 'x')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run('ownerB', () => hr.rules.runner.runNow(companyA))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(
      (await run('ownerB', () => hr.rules.findings.list({ companyId: companyB }))).map(
        (f) => f.code,
      ),
    ).toEqual(['R2', 'R2', 'R11']);
    expect(
      (await run('auditor', () => hr.rules.findings.list({ companyId: companyA }))).length,
    ).toBeGreaterThan(0);
    await expect(
      run('auditor', () => hr.rules.commands.accept(aFinding!.id, 'x')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      run('admin', () => hr.rules.findings.list({ companyId: companyA })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a write whose result breaks R1, R2, R3 or R15, and passes primary + acting', async () => {
    const base: OrgSnapshot = {
      companyId: companyA,
      asOf: ON,
      units: [
        { id: 'u1', parentId: null, supervisorPositionId: 'p1' },
        { id: 'u2', parentId: 'u1', supervisorPositionId: 'p2' },
      ],
      positions: ['p1', 'p2', 'p3'].map((id) => ({
        id,
        unitId: id === 'p1' ? 'u1' : 'u2',
        titleFa: 'کارشناس',
        titleEn: null,
        supervisory: id !== 'p3',
        status: 'active' as const,
        proposedSince: null,
        vacantSince: null,
        filled: true,
      })),
      directLines: [
        { from: 'p2', to: 'p1' },
        { from: 'p3', to: 'p2' },
      ],
      assignments: [
        { personId: 'a', positionId: 'p1', kind: 'primary', timeShare: 1 },
        { personId: 'b', positionId: 'p2', kind: 'primary', timeShare: 1 },
        { personId: 'b', positionId: 'p1', kind: 'acting', timeShare: 1 },
        { personId: 'c', positionId: 'p3', kind: 'primary', timeShare: 1 },
      ],
      employed: ['a', 'b', 'c'],
    };
    const ok = await asUser(() => hr.rules.checker.checkBlocking(base));
    expect(ok.result).toMatchObject({ ok: true, violations: [] });
    expect(ok.result.records.map((r) => r.rule.id)).toEqual([
      'org.unit_single_parent',
      'org.position_single_direct_line',
      'org.person_time_share',
      'org.single_supervisor',
    ]);

    const broken: OrgSnapshot = {
      ...base,
      units: [
        { id: 'u1', parentId: 'u2', supervisorPositionId: 'p1' },
        { id: 'u2', parentId: 'u1', supervisorPositionId: 'p2' },
      ],
      directLines: [...base.directLines, { from: 'p3', to: 'p1' }],
      assignments: [
        ...base.assignments,
        { personId: 'c', positionId: 'p1', kind: 'project', timeShare: 0.5 },
        { personId: 'd', positionId: 'p2', kind: 'primary', timeShare: 1 },
      ],
    };
    const refused = (await asUser(() => hr.rules.checker.checkBlocking(broken))).result;
    expect(refused.ok).toBe(false);
    expect(refused.violations.map((v) => `${v.code}:${v.subject.id}:${v.key}`).sort()).toEqual(
      [
        'R1:u1:cycle',
        'R1:u2:cycle',
        'R2:p3:two_direct_lines',
        'R3:c:over_share',
        'R15:p2:two_primary_incumbents',
      ].sort(),
    );

    const backdated = await asUser(() =>
      hr.rules.checker.checkBackdated({
        companyId: companyA,
        changeId: 'change-1',
        effectiveDate: '2026-10-01' as platformV1.BusinessDate,
        today: ON,
      }),
    );
    expect(backdated.result.violations).toEqual([
      expect.objectContaining({
        code: 'R4',
        key: 'backdated',
        detail: expect.objectContaining({ daysBack: 52 }),
      }),
    ]);
  });
});

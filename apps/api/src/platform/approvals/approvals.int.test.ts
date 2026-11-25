import { ConflictException, ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { platformV1 } from '@eve/contracts';
import {
  asUser,
  createPlatform,
  ensureTimeZone,
  type Platform,
  uniqueCompanyCode,
  uniqueUsername,
} from '../../../test/platform';
import { businessDateIn } from '../dates/dates';

function addDays(day: platformV1.BusinessDate, days: number): platformV1.BusinessDate {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) as platformV1.BusinessDate;
}
import { sampleThresholdTemplates } from '../rules/sample/sample-threshold.template';

const TYPE = 'platform.rule_params.change';
/** This file's own copy of the sample rule. */
const RULE = 'test.approvals_sample';
const [SampleV1, SampleV2] = sampleThresholdTemplates(RULE);

describe('approvals: chains, four-eyes, return/resubmit, concurrency', () => {
  let platform: Platform;
  let today: platformV1.BusinessDate;
  let companyA: string;
  let companyB: string;
  const people = { admin: '', approver1: '', approver2: '', approverA: '', auditor: '' };

  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });
  const payload = (threshold: number, validFrom = today) => ({
    templateId: RULE,
    templateVersion: 1,
    params: { threshold },
    validFrom,
  });

  let phoneSeq = 1_000_000;
  const phoneOf = new Map<string, string>();

  async function person(grants: { role: string; companyId?: string }[]): Promise<string> {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('appr'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        // A distinct number per person, so notifications can be told apart.
        contactAddress: `0912${String(++phoneSeq).padStart(7, '0')}`,
        reason: 'approvals test',
      }),
    );
    for (const g of grants) {
      await asUser(() =>
        platform.users.grantRole({
          userId: result.id,
          role: g.role,
          scopeKind: g.companyId ? 'company' : 'customer',
          companyId: g.companyId ?? null,
          unitId: null,
          reason: 't',
        }),
      );
    }
    phoneOf.set(result.id, `0912${String(phoneSeq).padStart(7, '0')}`);
    return result.id;
  }

  const submit = (threshold: number, companyId: string | null = null, validFrom = today) =>
    asUser(
      () =>
        platform.approvals.submit({
          type: TYPE,
          companyId,
          payload: payload(threshold, validFrom),
          reason: 'test',
        }),
      as(people.admin),
    ).then((r) => r.result);

  const setChain = (chain: string[], companyId: string | null = null) =>
    asUser(() =>
      platform.config.set({
        setting: platform.approvalTypes.chainSetting(TYPE),
        companyId,
        value: chain,
        reason: 'test chain',
      }),
    );

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    platform.rules.register(SampleV1, SampleV2);
    await ensureTimeZone(platform);
    today = businessDateIn(new Date(), 'Asia/Tehran');
    companyA = (
      await asUser(() =>
        platform.companies.register({
          code: uniqueCompanyCode('A'),
          jurisdictionCode: 'ir',
          reason: 't',
        }),
      )
    ).result.id;
    companyB = (
      await asUser(() =>
        platform.companies.register({
          code: uniqueCompanyCode('B'),
          jurisdictionCode: 'ir',
          reason: 't',
        }),
      )
    ).result.id;
    // The admin also holds rule_approver: four-eyes must still stop self-approval.
    people.admin = await person([{ role: 'system_admin' }, { role: 'rule_approver' }]);
    people.approver1 = await person([{ role: 'rule_approver' }]);
    people.approver2 = await person([{ role: 'rule_approver' }]);
    people.approverA = await person([{ role: 'rule_approver', companyId: companyA }]);
    people.auditor = await person([{ role: 'auditor' }]);
    await setChain(['rule_approver']);
  });

  afterAll(() => platform.close());

  it('runs a one-step request to approval and applies it in the same transaction', async () => {
    const request = await submit(4);
    expect(request).toMatchObject({
      status: 'pending',
      currentStep: 0,
      revision: 1,
      chain: ['rule_approver'],
    });
    const approved = (
      await asUser(() => platform.approvals.approve(request.id, 'fine'), as(people.approver1))
    ).result;
    expect(approved.status).toBe('approved');

    const written = await platform.prisma.rulesParamVersion.findFirst({
      where: { approvalRequestId: request.id },
    });
    expect(written?.params).toEqual({ threshold: 4 });
    const audit = await platform.prisma.auditLog.findMany({
      where: { entityId: request.id },
      orderBy: { seq: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'platform.approval.submit',
      'platform.approval.approve',
    ]);
    const events = await platform.prisma.eventsOutbox.findMany({
      where: { payload: { path: ['request_id'], equals: request.id } },
    });
    expect(events.map((e) => e.type).sort()).toEqual([
      'platform.approval.decided',
      'platform.approval.requested',
    ]);
  });

  it('never lets the requester approve their own request', async () => {
    const request = await submit(5);
    await expect(
      asUser(() => platform.approvals.approve(request.id, null), as(people.admin)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires the step role over the request company', async () => {
    const forB = await submit(6, companyB);
    await expect(
      asUser(() => platform.approvals.approve(forB.id, null), as(people.approverA)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      asUser(() => platform.approvals.approve(forB.id, null), as(people.auditor)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const forA = await submit(6, companyA);
    expect(
      (await asUser(() => platform.approvals.approve(forA.id, null), as(people.approverA))).result
        .status,
    ).toBe('approved');
  });

  it('shows each approver only what they can act on now', async () => {
    const forB = await submit(7, companyB);
    const inboxA = (
      await asUser(() => platform.approvals.inbox(), as(people.approverA))
    ).result.map((r) => r.id);
    const inbox1 = (
      await asUser(() => platform.approvals.inbox(), as(people.approver1))
    ).result.map((r) => r.id);
    const inboxAdmin = (
      await asUser(() => platform.approvals.inbox(), as(people.admin))
    ).result.map((r) => r.id);
    expect(inboxA).not.toContain(forB.id);
    expect(inbox1).toContain(forB.id);
    expect(inboxAdmin).not.toContain(forB.id); // their own request
  });

  it('returns to the requester, who resubmits a new revision from step 1', async () => {
    await setChain(['rule_approver', 'rule_approver']);
    const request = await submit(8);
    await asUser(() => platform.approvals.approve(request.id, null), as(people.approver1));
    const returned = (
      await asUser(
        () => platform.approvals.returnToRequester(request.id, 'use 9'),
        as(people.approver2),
      )
    ).result;
    expect(returned).toMatchObject({ status: 'returned', revision: 1, currentStep: 1 });
    await expect(
      asUser(() => platform.approvals.approve(request.id, null), as(people.approver1)),
    ).rejects.toBeInstanceOf(ConflictException);

    const resubmitted = (
      await asUser(
        () => platform.approvals.resubmit(request.id, payload(9), 'changed to 9'),
        as(people.admin),
      )
    ).result;
    expect(resubmitted).toMatchObject({
      status: 'pending',
      revision: 2,
      currentStep: 0,
      payload: payload(9),
    });
    // approver1 approved a step in revision 1; revision 2 starts fresh.
    await asUser(() => platform.approvals.approve(request.id, null), as(people.approver1));
    const done = (
      await asUser(() => platform.approvals.approve(request.id, null), as(people.approver2))
    ).result;
    expect(done.status).toBe('approved');

    const view = (await asUser(() => platform.approvals.get(request.id), as(people.admin))).result;
    expect(view.history.map((h) => `${h.revision}:${h.action}`)).toEqual([
      '1:submit',
      '1:approve',
      '1:return',
      '2:resubmit',
      '2:approve',
      '2:approve',
    ]);
    await setChain(['rule_approver']);
  });

  it('lets one person approve at most one step of a revision', async () => {
    await setChain(['rule_approver', 'rule_approver']);
    const request = await submit(10);
    await asUser(() => platform.approvals.approve(request.id, null), as(people.approver1));
    await expect(
      asUser(() => platform.approvals.approve(request.id, null), as(people.approver1)),
    ).rejects.toThrow('at most one step');
    await setChain(['rule_approver']);
  });

  it('keeps the chain a request was submitted with', async () => {
    const request = await submit(11); // chain: [rule_approver]
    await setChain(['rule_approver', 'auditor']);
    const approved = (
      await asUser(() => platform.approvals.approve(request.id, null), as(people.approver1))
    ).result;
    expect(approved).toMatchObject({ status: 'approved', chain: ['rule_approver'] });
    await setChain(['rule_approver']);
  });

  it('lets exactly one of two concurrent decisions win', async () => {
    const request = await submit(12);
    const results = await Promise.allSettled([
      asUser(() => platform.approvals.approve(request.id, null), as(people.approver1)),
      asUser(() => platform.approvals.reject(request.id, 'no'), as(people.approver2)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected');
    expect(loser && 'reason' in loser ? loser.reason : null).toBeInstanceOf(ConflictException);
  });

  it('cannot approve a cancelled request; only the requester cancels', async () => {
    const request = await submit(13);
    await expect(
      asUser(() => platform.approvals.cancel(request.id, 'mine?'), as(people.approver1)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await asUser(() => platform.approvals.cancel(request.id, 'not needed'), as(people.admin));
    await expect(
      asUser(() => platform.approvals.approve(request.id, null), as(people.approver1)),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('expires a request whose date passed while waiting, instead of applying it', async () => {
    const request = await submit(14);
    platform.clock.advance(2 * 86_400_000);
    try {
      await expect(
        asUser(() => platform.approvals.approve(request.id, null), as(people.approver1)),
      ).rejects.toThrow('expired');
      const row = await platform.prisma.approvalsRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      expect(row.status).toBe('expired');
      expect(
        await platform.prisma.rulesParamVersion.count({ where: { approvalRequestId: request.id } }),
      ).toBe(0);
      const actions = await platform.prisma.approvalsAction.findMany({
        where: { requestId: request.id },
        orderBy: { at: 'asc' },
      });
      expect(actions.map((a) => [a.action, a.actorId === null])).toEqual([
        ['submit', false],
        ['expire', true],
      ]);
    } finally {
      platform.clock.reset();
    }
  });

  it('expires waiting requests nightly and informs requester, admins and the next approvers', async () => {
    const request = await submit(16);
    const other = await submit(17, null, addDays(today, 30)); // not due yet
    platform.clock.advance(2 * 86_400_000);
    try {
      expect(await platform.approvals.expireDue()).toBeGreaterThanOrEqual(1);
    } finally {
      platform.clock.reset();
    }
    expect(
      (await platform.prisma.approvalsRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .status,
    ).toBe('expired');
    expect(
      (await platform.prisma.approvalsRequest.findUniqueOrThrow({ where: { id: other.id } }))
        .status,
    ).toBe('pending');

    const told = (userId: string) => platform.stubChannel.lastTo(phoneOf.get(userId) as string);
    for (const userId of [people.admin, people.approver1, people.approver2]) {
      expect(told(userId)).toMatchObject({
        template: 'approvals.expired',
        params: { requestId: expect.any(String) },
      });
    }
    expect(told(people.auditor)?.template).not.toBe('approvals.expired');

    const audit = await platform.prisma.auditLog.findFirstOrThrow({
      where: { entityId: request.id, action: 'platform.approval.expire' },
    });
    expect(audit.actor).toEqual({ kind: 'system', id: 'approvals:expiry' });
    const event = await platform.prisma.eventsOutbox.findFirstOrThrow({
      where: {
        type: 'platform.approval.decided',
        payload: { path: ['request_id'], equals: request.id },
      },
    });
    expect(event.payload).toMatchObject({ outcome: 'expired' });
  });

  it('requires a note to reject or return', async () => {
    const request = await submit(15);
    await expect(
      asUser(() => platform.approvals.reject(request.id, ' '), as(people.approver1)),
    ).rejects.toThrow('note');
  });
});

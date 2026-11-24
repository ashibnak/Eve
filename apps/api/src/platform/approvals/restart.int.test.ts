import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, inject, it } from 'vitest';
import type { platformV1 } from '@eve/contracts';
import { asUser, uniqueUsername } from '../../../test/platform';
import { AppModule } from '../../app.module';
import { UserService } from '../auth/user.service';
import { ConfigService } from '../config/config.service';
import { TimeZoneSetting } from '../config/settings';
import { businessDateIn } from '../dates/dates';
import { PrismaService } from '../db/prisma.service';
import { RuleRegistry } from '../rules/rule-registry';
import { sampleThresholdTemplates } from '../rules/sample/sample-threshold.template';
import { ApprovalService } from './approval.service';
import { ApprovalTypeRegistry } from './request-types';

const TYPE = 'platform.rule_params.change';
/** This file's own copy of the sample rule. */
const RULE = 'test.restart_sample';

/** Boots the real application (no HTTP, no worker) against the test database. */
async function boot(): Promise<INestApplicationContext> {
  process.env.DATABASE_URL = inject('db').appUrl;
  process.env.EVE_WORKER = 'off';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  // Rule templates are registered by code at every start, as packs will do.
  app.get(RuleRegistry).register(...sampleThresholdTemplates(RULE));
  return app;
}

describe('approvals survive an application restart (S2 done-when 2)', () => {
  it('continues a two-step request in a fresh application instance', async () => {
    const today = businessDateIn(new Date(), 'Asia/Tehran') as platformV1.BusinessDate;
    const people = { requester: '', approver: '', admin2: '' };
    let requestId = '';

    // ── First run: set up, submit, approve step 1, shut down. ──────────────────
    const first = await boot();
    try {
      await asUser(async () => {
        const config = first.get(ConfigService);
        await config.set({
          setting: TimeZoneSetting,
          companyId: null,
          value: 'Asia/Tehran',
          reason: 'setup',
        });
        await config.set({
          setting: first.get(ApprovalTypeRegistry).chainSetting(TYPE),
          companyId: null,
          value: ['rule_approver', 'system_admin'],
          reason: 'two steps for this test',
        });
        const users = first.get(UserService);
        for (const [key, role] of [
          ['requester', 'system_admin'],
          ['approver', 'rule_approver'],
          ['admin2', 'system_admin'],
        ] as const) {
          const user = await users.create({
            username: uniqueUsername('restart'),
            password: 'a-long-enough-password',
            contactChannel: 'stub',
            contactAddress: '09120000000',
            reason: 'restart test',
          });
          await users.grantRole({
            userId: user.id,
            role,
            scopeKind: 'customer',
            companyId: null,
            unitId: null,
            reason: 't',
          });
          people[key] = user.id;
        }
      });

      const approvals = first.get(ApprovalService);
      const submitted = await asUser(
        () =>
          approvals.submit({
            type: TYPE,
            companyId: null,
            payload: {
              templateId: RULE,
              templateVersion: 2,
              params: { threshold: 42 },
              validFrom: today,
            },
            reason: 'restart test',
          }),
        { actor: { kind: 'user', id: people.requester } },
      );
      requestId = submitted.result.id;
      const afterStep1 = await asUser(() => approvals.approve(requestId, 'step 1 ok'), {
        actor: { kind: 'user', id: people.approver },
      });
      expect(afterStep1.result).toMatchObject({ status: 'pending', currentStep: 1 });
    } finally {
      await first.close();
    }

    // ── Second run: a new process state; only the database remembers. ─────────
    const second = await boot();
    try {
      const approvals = second.get(ApprovalService);
      const inbox = await asUser(() => approvals.inbox(), {
        actor: { kind: 'user', id: people.admin2 },
      });
      expect(inbox.result.map((r) => r.id)).toContain(requestId);

      const done = await asUser(() => approvals.approve(requestId, 'step 2 ok'), {
        actor: { kind: 'user', id: people.admin2 },
      });
      expect(done.result).toMatchObject({
        status: 'approved',
        chain: ['rule_approver', 'system_admin'],
      });

      const prisma = second.get(PrismaService);
      const written = await prisma.rulesParamVersion.findFirstOrThrow({
        where: { approvalRequestId: requestId },
      });
      expect(written).toMatchObject({
        templateId: RULE,
        templateVersion: 2,
        params: { threshold: 42 },
      });

      const audit = await prisma.auditLog.findMany({
        where: { entityId: requestId },
        orderBy: { seq: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual([
        'platform.approval.submit',
        'platform.approval.approve',
        'platform.approval.approve',
      ]);
      const events = await prisma.eventsOutbox.findMany({
        where: { payload: { path: ['request_id'], equals: requestId } },
        orderBy: { seq: 'asc' },
      });
      expect(events.map((e) => e.type)).toEqual([
        'platform.approval.requested',
        'platform.approval.requested',
        'platform.approval.decided',
      ]);
    } finally {
      await second.close();
    }
  });
});

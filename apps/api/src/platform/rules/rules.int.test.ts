import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { platformV1 } from '@eve/contracts';
import {
  asUser,
  createPlatform,
  ensureTimeZone,
  type Platform,
  rawClient,
  uniqueCompanyCode,
  uniqueUsername,
} from '../../../test/platform';
import { businessDateIn } from '../dates/dates';
import { RuleReplayMismatchError } from './rule-runtime';
import { sampleThresholdTemplates } from './sample/sample-threshold.template';

/** This file's own copy of the sample rule: no other test file touches its parameters. */
const RULE = 'test.rules_sample';
const [SampleV1, SampleV2] = sampleThresholdTemplates(RULE);

function addDays(day: platformV1.BusinessDate, days: number): platformV1.BusinessDate {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) as platformV1.BusinessDate;
}

describe('rules: templates, versioned parameters and replay (S2 done-when 1)', () => {
  let platform: Platform;
  let admin: string;
  let approver: string;
  let companyId: string;
  let today: platformV1.BusinessDate;

  const as = (userId: string) => ({ actor: { kind: 'user' as const, id: userId } });

  async function user(role: string): Promise<string> {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('rules'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'rules test',
      }),
    );
    await asUser(() =>
      platform.users.grantRole({
        userId: result.id,
        role,
        scopeKind: 'customer',
        companyId: null,
        unitId: null,
        reason: 't',
      }),
    );
    return result.id;
  }

  /** Proposes parameters as the admin and approves them as the rule approver. */
  async function changeParams(
    version: number,
    params: unknown,
    validFrom: platformV1.BusinessDate,
    company: string | null = null,
  ): Promise<string> {
    const { result: request } = await asUser(
      () =>
        platform.approvals.submit({
          type: 'platform.rule_params.change',
          companyId: company,
          payload: { templateId: RULE, templateVersion: version, params, validFrom },
          reason: 'tune the sample rule',
        }),
      as(admin),
    );
    await asUser(() => platform.approvals.approve(request.id, null), as(approver));
    return request.id;
  }

  const evaluate = (
    input: unknown,
    options: Partial<{
      version: number;
      asOf: platformV1.BusinessDate;
      companyId: string | null;
      knownAt: Date;
    }> = {},
  ) =>
    platform.ruleRuntime.evaluate(
      { id: RULE, ...(options.version ? { version: options.version } : {}) },
      input,
      {
        asOf: options.asOf ?? today,
        companyId: options.companyId ?? null,
        ...(options.knownAt ? { knownAt: options.knownAt } : {}),
      },
    );

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    platform.rules.register(SampleV1, SampleV2);
    await ensureTimeZone(platform);
    // Other test files change the approval chain in this shared database; this file needs one step.
    await asUser(() =>
      platform.config.set({
        setting: platform.approvalTypes.chainSetting('platform.rule_params.change'),
        companyId: null,
        value: ['rule_approver'],
        reason: 'test chain',
      }),
    );
    today = businessDateIn(new Date(), 'Asia/Tehran');
    admin = await user('system_admin');
    approver = await user('rule_approver');
    companyId = (
      await asUser(() =>
        platform.companies.register({
          code: uniqueCompanyCode('R'),
          jurisdictionCode: 'ir',
          reason: 't',
        }),
      )
    ).result.id;
  });

  afterAll(() => platform.close());

  it('keeps v1 and v2 side by side; replaying a v1 record gives the old result', async () => {
    // v1 with defaults (threshold 10): 10 is not above 10.
    const v1Record = await evaluate({ value: 10 }, { version: 1 });
    expect(v1Record).toMatchObject({
      rule: { id: RULE, version: 1 },
      paramVersionId: null,
      params: { threshold: 10 },
      output: { exceeds: false },
    });

    // Latest is v2 (>=): same input, different result.
    const latest = await evaluate({ value: 10 });
    expect(latest.rule.version).toBe(2);
    expect(latest.output).toEqual({ exceeds: true });

    // The customer lowers v1's threshold through approval.
    await changeParams(1, { threshold: 5 }, today);
    const v1Now = await evaluate({ value: 10 }, { version: 1 });
    expect(v1Now.output).toEqual({ exceeds: true });
    expect(v1Now.paramVersionId).not.toBeNull();

    // The old record still replays to its old result, with no database lookup.
    expect(platform.ruleRuntime.replay(v1Record)).toEqual({ exceeds: false });
    expect(platform.ruleRuntime.replay(v1Now)).toEqual({ exceeds: true });
  });

  it('detects a record whose output or parameters were altered', async () => {
    const record = await evaluate({ value: 3 }, { version: 2 });
    expect(() => platform.ruleRuntime.replay({ ...record, output: { exceeds: true } })).toThrow(
      RuleReplayMismatchError,
    );
    expect(() => platform.ruleRuntime.replay({ ...record, params: { threshold: 1 } })).toThrow(
      'do not match their hash',
    );
  });

  it('answers "as known at" a moment before a change', async () => {
    const before = new Date();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await changeParams(2, { threshold: 50 }, today);
    expect((await evaluate({ value: 20 }, { version: 2 })).output).toEqual({ exceeds: false });
    const then = await evaluate({ value: 20 }, { version: 2, knownAt: before });
    expect(then).toMatchObject({
      paramVersionId: null,
      params: { threshold: 10 },
      output: { exceeds: true },
    });
  });

  it('schedules future values without touching today, and splits periods instead of rewriting', async () => {
    const in30 = addDays(today, 30);
    const in10 = addDays(today, 10);
    await changeParams(2, { threshold: 70 }, in30);
    expect((await evaluate({ value: 60 }, { version: 2 })).params).toEqual({ threshold: 50 });
    expect((await evaluate({ value: 60 }, { version: 2, asOf: in30 })).params).toEqual({
      threshold: 70,
    });

    // A change from day 10 replaces the scheduled day-30 value too.
    await changeParams(2, { threshold: 60 }, in10);
    expect((await evaluate({ value: 1 }, { version: 2, asOf: addDays(today, 9) })).params).toEqual({
      threshold: 50,
    });
    expect((await evaluate({ value: 1 }, { version: 2, asOf: in10 })).params).toEqual({
      threshold: 60,
    });
    expect((await evaluate({ value: 1 }, { version: 2, asOf: in30 })).params).toEqual({
      threshold: 60,
    });

    const current = await platform.prisma.rulesParamVersion.findMany({
      where: { templateId: RULE, templateVersion: 2, companyId: null, supersededAt: null },
      orderBy: { validFrom: 'asc' },
    });
    expect(
      current.map((r) => [
        r.validFrom.toISOString().slice(0, 10),
        r.validTo?.toISOString().slice(0, 10) ?? null,
      ]),
    ).toEqual([
      [today, in10],
      [in10, null],
    ]);
  });

  it('prefers a company value over the customer value', async () => {
    await changeParams(1, { threshold: 100 }, today, companyId);
    expect((await evaluate({ value: 50 }, { version: 1, companyId })).params).toEqual({
      threshold: 100,
    });
    expect((await evaluate({ value: 50 }, { version: 1 })).params).toEqual({ threshold: 5 });
  });

  it('refuses a past effective date and invalid parameters', async () => {
    const submit = (params: unknown, validFrom: platformV1.BusinessDate) =>
      asUser(
        () =>
          platform.approvals.submit({
            type: 'platform.rule_params.change',
            companyId: null,
            payload: { templateId: RULE, templateVersion: 1, params, validFrom },
            reason: 'test',
          }),
        as(admin),
      );
    await expect(submit({ threshold: 3 }, addDays(today, -1))).rejects.toThrow('from today');
    await expect(submit({ threshold: -1 }, today)).rejects.toMatchObject({
      response: { error: 'invalid_params' },
    });
  });

  it('enforces in the database: no overlapping periods, no rewritten values', async () => {
    const owner = await rawClient(inject('db').ownerUrl);
    const app = await rawClient(inject('db').appUrl);
    try {
      await expect(
        owner.query(
          `INSERT INTO rules_param_version (template_id, template_version, params, valid_from, recorded_at)
           VALUES ($1, 2, '{"threshold":1}', $2, now())`,
          [RULE, addDays(today, 15)],
        ),
      ).rejects.toThrow(/rules_param_version_no_overlap/);
      await expect(
        app.query(`UPDATE rules_param_version SET params = '{"threshold":0}'`),
      ).rejects.toThrow(/permission denied/);
      await expect(app.query('DELETE FROM rules_param_version')).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await owner.end();
      await app.end();
    }
  });
});

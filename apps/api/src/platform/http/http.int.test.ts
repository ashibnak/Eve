import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, uniqueCompanyCode, uniqueUsername } from '../../../test/platform';
import { AppModule } from '../../app.module';
import { UserService } from '../auth/user.service';
import { ChannelRegistry } from '../channels/channel';
import type { StubChannel } from '../channels/stub.channel';
import { ConfigService } from '../config/config.service';
import { TimeZoneSetting } from '../config/settings';
import { HomeJurisdictionSetting } from '../jurisdiction/jurisdiction.registry';
import { jurisdiction as ir } from '@eve/jurisdiction-ir';
import type { platformV1 } from '@eve/contracts';
import { PrismaService } from '../db/prisma.service';
import { RuleRegistry } from '../rules/rule-registry';
import { sampleThresholdTemplates } from '../rules/sample/sample-threshold.template';
import { configureApp } from './configure-app';

const PASSWORD = 'a-long-enough-password';

/** A minimal cookie-keeping HTTP client for one user. */
class Client {
  private cookie = '';

  get cookieHeader(): string {
    return this.cookie;
  }

  constructor(private readonly base: string) {}

  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0] ?? '';
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null, setCookie };
  }
}

describe('HTTP API: login, deny by default, scoped reads', () => {
  let app: INestApplication;
  let base: string;
  let stub: StubChannel;

  async function login(username: string, address: string): Promise<Client> {
    const client = new Client(base);
    const step1 = await client.call('POST', '/auth/login', { username, password: PASSWORD });
    expect(step1.status).toBe(200);
    const code = stub.lastTo(address)?.params.code;
    const step2 = await client.call('POST', '/auth/code', { code });
    expect(step2.status).toBe(200);
    return client;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = inject('db').appUrl;
    process.env.EVE_WORKER = 'off';
    app = await NestFactory.create(AppModule, { logger: ['error'] });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    stub = app.get(ChannelRegistry).get('stub') as StubChannel;
    app.get(RuleRegistry).register(...sampleThresholdTemplates('test.http_sample'));

    // First administrator, as the bootstrap CLI would create it.
    await asUser(async () => {
      const config = app.get(ConfigService);
      await config.set({
        setting: TimeZoneSetting,
        companyId: null,
        value: 'Asia/Tehran',
        reason: 'setup',
      });
      await config.set({
        setting: HomeJurisdictionSetting,
        companyId: null,
        value: 'ir',
        reason: 'setup',
      });
      const users = app.get(UserService);
      const admin = await users.create({
        username: 'http.admin',
        password: PASSWORD,
        contactChannel: 'stub',
        contactAddress: '09121111111',
        reason: 'setup',
      });
      await users.grantRole({
        userId: admin.id,
        role: 'system_admin',
        scopeKind: 'customer',
        companyId: null,
        unitId: null,
        reason: 'setup',
      });
    });
  });

  afterAll(() => app.close());

  it('serves health without a session and nothing else', async () => {
    const anonymous = new Client(base);
    expect((await anonymous.call('GET', '/health')).status).toBe(200);
    expect((await anonymous.call('GET', '/auth/me')).status).toBe(401);
    expect((await anonymous.call('GET', '/platform/companies')).status).toBe(401);
  });

  it('sets a secure, httpOnly, SameSite=Strict cookie scoped to /api', async () => {
    const client = new Client(base);
    const { setCookie } = await client.call('POST', '/auth/login', {
      username: 'http.admin',
      password: PASSWORD,
    });
    expect(setCookie).toMatch(/eve_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api/);
    // The pending session (code not entered) does not authenticate.
    expect((await client.call('GET', '/auth/me')).status).toBe(401);
  });

  it('rejects a wrong password with 401 and a malformed body with 400', async () => {
    const client = new Client(base);
    expect(
      (await client.call('POST', '/auth/login', { username: 'http.admin', password: 'nope' }))
        .status,
    ).toBe(401);
    expect((await client.call('POST', '/auth/login', { username: 'http.admin' })).status).toBe(400);
  });

  it('lets an admin set up companies and auditors; each auditor sees only their company', async () => {
    const admin = await login('http.admin', '09121111111');
    const me = await admin.call('GET', '/auth/me');
    expect(me.body).toMatchObject({
      username: 'http.admin',
      roles: [{ role: 'system_admin', scopeKind: 'customer' }],
    });

    const companyA = (
      await admin.call('POST', '/platform/companies', {
        code: uniqueCompanyCode('A'),
        jurisdictionCode: 'ir',
        reason: 'pilot',
      })
    ).body as { id: string };
    const companyB = (
      await admin.call('POST', '/platform/companies', {
        code: uniqueCompanyCode('B'),
        jurisdictionCode: 'ir',
        reason: 'pilot',
      })
    ).body as { id: string };

    // Registering a company writes an audit row in that company, so each has company data.
    const auditorA = uniqueUsername('audit.a');
    const created = await admin.call('POST', '/platform/users', {
      username: auditorA,
      password: PASSWORD,
      contactChannel: 'stub',
      contactAddress: '09122222222',
      reason: 'auditor for A',
    });
    expect(created.status).toBe(201);
    const auditorAId = (created.body as { id: string }).id;
    const granted = await admin.call('POST', `/platform/users/${auditorAId}/roles`, {
      role: 'auditor',
      scopeKind: 'company',
      companyId: companyA.id,
      reason: 'auditor for A',
    });
    expect(granted.status).toBe(201);

    // The admin has no audit access (product-owner decision).
    expect((await admin.call('GET', '/platform/audit')).status).toBe(403);

    const auditor = await login(auditorA, '09122222222');
    const companies = (await auditor.call('GET', '/platform/companies')).body as { id: string }[];
    expect(companies.map((c) => c.id)).toEqual([companyA.id]);

    const audit = (await auditor.call('GET', '/platform/audit?limit=200')).body as {
      companyId: string | null;
    }[];
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((row) => row.companyId === companyA.id)).toBe(true);

    expect((await auditor.call('GET', `/platform/audit?companyId=${companyB.id}`)).status).toBe(
      403,
    );
    expect((await auditor.call('GET', '/platform/config/platform.time_zone')).status).toBe(403);
    expect((await auditor.call('GET', '/platform/users')).status).toBe(403);
    expect(
      (
        await auditor.call('POST', '/platform/companies', {
          code: 'X1',
          jurisdictionCode: 'ir',
          reason: 'x',
        })
      ).status,
    ).toBe(403);
  });

  it('refuses a company in a jurisdiction this deployment does not ship', async () => {
    const admin = await login('http.admin', '09121111111');
    const res = await admin.call('POST', '/platform/companies', {
      code: uniqueCompanyCode('X'),
      jurisdictionCode: 'zz',
      reason: 'x',
    });
    expect(res.status).toBe(400);
  });

  it('reports the current Jalali month of usage to the administrator only', async () => {
    const admin = await login('http.admin', '09121111111');
    await admin.call('GET', '/auth/me');
    await admin.call('GET', '/platform/companies');
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Tehran',
    }) as platformV1.BusinessDate;
    const { year, month } = ir.calendar.fromBusinessDate(today);

    // Counting runs after the response; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const res = await admin.call('GET', `/platform/usage/monthly?year=${year}&month=${month}`);
    expect(res.status).toBe(200);
    const report = res.body as {
      calendar: string;
      activeUsers: number;
      requests: Record<string, number>;
    };
    expect(report.calendar).toBe('persian');
    expect(report.activeUsers).toBeGreaterThanOrEqual(1);
    expect(report.requests.platform).toBeGreaterThanOrEqual(1);
    expect(report.requests.auth).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(report)).not.toContain('http.admin'); // aggregates only, no names

    const anonymous = new Client(base);
    expect(
      (await anonymous.call('GET', `/platform/usage/monthly?year=${year}&month=${month}`)).status,
    ).toBe(401);
    expect((await admin.call('GET', '/platform/usage/monthly?year=1405&month=13')).status).toBe(
      400,
    );
  });

  it('changes rule parameters only through an approver, never the proposer', async () => {
    const admin = await login('http.admin', '09121111111');
    const approverName = uniqueUsername('rule.appr');
    const created = await admin.call('POST', '/platform/users', {
      username: approverName,
      password: PASSWORD,
      contactChannel: 'stub',
      contactAddress: '09123333333',
      reason: 'rule approver',
    });
    const approverId = (created.body as { id: string }).id;
    await admin.call('POST', `/platform/users/${approverId}/roles`, {
      role: 'rule_approver',
      scopeKind: 'customer',
      reason: 'rule approver',
    });

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
    const proposed = await admin.call('POST', '/platform/rules/test.http_sample/1/params', {
      params: { threshold: 3 },
      validFrom: today,
      reason: 'lower the sample threshold',
    });
    expect(proposed.status).toBe(201);
    const request = proposed.body as { id: string; status: string; chain: string[] };
    expect(request).toMatchObject({ status: 'pending', chain: ['rule_approver'] });

    // Four-eyes: the admin cannot approve it, and it is not in their inbox.
    expect((await admin.call('POST', `/platform/approvals/${request.id}/approve`, {})).status).toBe(
      403,
    );
    expect((await admin.call('GET', '/platform/approvals/mine')).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: request.id })]),
    );

    const approver = await login(approverName, '09123333333');
    const inbox = (await approver.call('GET', '/platform/approvals/inbox')).body as {
      id: string;
    }[];
    expect(inbox.map((r) => r.id)).toContain(request.id);
    expect(
      (await approver.call('POST', `/platform/approvals/${request.id}/reject`, {})).status,
    ).toBe(400);
    const approved = await approver.call('POST', `/platform/approvals/${request.id}/approve`, {
      note: 'ok',
    });
    expect(approved.status).toBe(201);
    expect((approved.body as { status: string }).status).toBe('approved');

    const rules = (await admin.call('GET', '/platform/rules')).body as {
      id: string;
      version: number;
      params: unknown;
      latest: boolean;
    }[];
    expect(rules.find((r) => r.id === 'test.http_sample' && r.version === 1)).toMatchObject({
      params: { threshold: 3 },
      latest: false,
    });
    expect(rules.find((r) => r.id === 'test.http_sample' && r.version === 2)).toMatchObject({
      params: { threshold: 10 },
      latest: true,
    });

    const history = (await approver.call('GET', `/platform/approvals/${request.id}`)).body as {
      history: { action: string }[];
    };
    expect(history.history.map((h) => h.action)).toEqual(['submit', 'approve']);

    // The approver cannot propose (system administrators propose).
    expect(
      (
        await approver.call('POST', '/platform/rules/test.http_sample/1/params', {
          params: { threshold: 2 },
          validFrom: today,
          reason: 'x',
        })
      ).status,
    ).toBe(403);
  });

  it('logs out', async () => {
    const admin = await login('http.admin', '09121111111');
    expect((await admin.call('POST', '/auth/logout')).status).toBe(204);
    expect((await admin.call('GET', '/auth/me')).status).toBe(401);
  });

  it('passes a caller correlation id through to the audit log', async () => {
    const admin = await login('http.admin', '09121111111');
    const correlationId = '7d0f3c1e-2b4a-4c5d-8e6f-0a1b2c3d4e5f';
    const res = await fetch(`${base}/api/v1/platform/config/platform.time_zone`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: admin.cookieHeader,
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify({ companyId: null, value: 'Asia/Tehran', reason: 'confirm time zone' }),
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('x-correlation-id')).toBe(correlationId);
    const audit = await app.get(PrismaService).auditLog.findMany({ where: { correlationId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'platform.config.set', source: 'manual' });
  });
});

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { orgV1 } from '@eve/contracts';
import { appPrisma } from '../../../../../test/hr';
import { HttpTestClient } from '../../../../../test/http-client';
import { asUser, uniqueCompanyCode, uniqueUsername } from '../../../../../test/platform';
import { AppModule } from '../../../../app.module';
import { UserService } from '../../../../platform/auth/user.service';
import { ChannelRegistry } from '../../../../platform/channels/channel';
import { CompanyService } from '../../../../platform/company/company.service';
import type { StubChannel } from '../../../../platform/channels/stub.channel';
import { ConfigService } from '../../../../platform/config/config.service';
import { TimeZoneSetting } from '../../../../platform/config/settings';
import { configureApp } from '../../../../platform/http/configure-app';
import { OrgFixture } from './org.fixture';

const PASSWORD = 'a-long-enough-password';

/** The real Nest wiring: org and people reach each other through their adapters at run time. */
describe('org over HTTP (real app wiring)', () => {
  let app: INestApplication;
  let base: string;
  let stub: StubChannel;
  let users: UserService;
  let companyId: string;
  const pos: Record<string, string> = {};
  const per: Record<string, string> = {};
  let unitId: string;
  let address = 9_127_000_000;

  /** A user (optionally with a role in the company) signed in over HTTP. */
  async function signedIn(role: string | null, personId: string | null) {
    const username = uniqueUsername('org.http');
    const contact = `0${(address += 1)}`;
    await asUser(async () => {
      const user = await users.create({
        username,
        password: PASSWORD,
        contactChannel: 'stub',
        contactAddress: contact,
        reason: 'setup',
      });
      if (role) {
        await users.grantRole({
          userId: user.id,
          role,
          scopeKind: 'company',
          companyId,
          unitId: null,
          reason: 'setup',
        });
      }
      if (personId) {
        await appPrisma(app).prisma.peopleUserLink.create({
          data: { userId: user.id, personId, companyId, linkedAt: new Date() },
        });
      }
    });
    const client = new HttpTestClient(base);
    expect(
      (await client.call('POST', '/auth/login', { username, password: PASSWORD })).status,
    ).toBe(200);
    const code = stub.lastTo(contact)?.params.code;
    expect((await client.call('POST', '/auth/code', { code })).status).toBe(200);
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
    users = app.get(UserService);
    await asUser(async () => {
      await app
        .get(ConfigService)
        .set({ setting: TimeZoneSetting, companyId: null, value: 'Asia/Tehran', reason: 'setup' });
    });
    companyId = (
      await asUser(() =>
        app.get(CompanyService).register({
          code: uniqueCompanyCode('OH'),
          jurisdictionCode: 'ir',
          reason: 'setup',
        }),
      )
    ).result.id;

    const f = new OrgFixture(companyId, `H${Date.now().toString(36).toUpperCase()}`.slice(0, 10));
    unitId = f.unit('ریشه');
    pos.head = f.position(unitId, 'مدیر', { supervisory: true });
    pos.staff = f.position(unitId, 'کارشناس', { reportsTo: pos.head });
    per.head = f.person('active', 'مدیر');
    per.staff = f.person('active', 'کارشناس');
    f.assign(per.head, pos.head);
    f.assign(per.staff, pos.staff);
    await f.save(appPrisma(app));
  });

  afterAll(() => app.close());

  it('serves the structure to the org data owner, and 404 for an unknown position', async () => {
    const owner = await signedIn('org_data_owner', null);
    const structure = await owner.call(
      'GET',
      `/org/companies/${companyId}/structure?asOf=2026-11-22`,
    );
    expect(structure.status).toBe(200);
    expect(orgV1.StructureSchema.parse(structure.body).positions).toHaveLength(2);
    const position = await owner.call('GET', `/org/positions/${pos.staff}?asOf=2026-11-22`);
    expect(orgV1.PositionViewSchema.parse(position.body).reportsToPositionId).toBe(pos.head);
    expect(
      (await owner.call('GET', '/org/positions/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
    expect(
      (await owner.call('GET', `/org/persons/${per.staff}/approval-chain?levels=0`)).status,
    ).toBe(400);
  });

  it('lets an employee see their manager, and a lead their team and its people', async () => {
    const staff = await signedIn(null, per.staff!);
    const manager = await staff.call('GET', `/org/persons/${per.staff}/manager?asOf=2026-11-22`);
    expect(manager.status).toBe(200);
    expect(manager.body).toEqual({
      manager: { personId: per.head, positionId: pos.head, via: 'primary', levelsUp: 1 },
    });
    expect((await staff.call('GET', `/org/positions/${pos.head}`)).status).toBe(403);
    expect((await staff.call('GET', `/people/persons/${per.head}`)).status).toBe(403);

    const lead = await signedIn(null, per.head!);
    const team = await lead.call(
      'GET',
      `/org/positions/${pos.head}/team?depth=subtree&asOf=2026-11-22`,
    );
    expect(team.status).toBe(200);
    const members = orgV1.OrgTools.getTeam.output.parse(team.body);
    expect(members[0]?.incumbents[0]).toMatchObject({
      personId: per.staff,
      personnelCode: '000002',
    });
    const person = await lead.call('GET', `/people/persons/${per.staff}?asOf=2026-11-22`);
    expect(person.status).toBe(200);
    expect((await lead.call('GET', `/org/companies/${companyId}/structure`)).status).toBe(403);
  });

  it('runs the rules and works the findings inbox over HTTP', async () => {
    const owner = await signedIn('org_data_owner', null);
    const run = await owner.call('POST', `/org/companies/${companyId}/rule-runs`);
    expect(run.status).toBe(201);
    expect(orgV1.RuleRunViewSchema.parse(run.body).trigger).toBe('manual');
    expect((await owner.call('GET', `/org/companies/${companyId}/rule-runs/latest`)).status).toBe(
      200,
    );

    // The tiny fixture has no supervisor set on its unit: R6, a warning.
    const inbox = await owner.call('GET', `/org/findings?companyId=${companyId}`);
    expect(inbox.status).toBe(200);
    const findings = (inbox.body as unknown[]).map((f) => orgV1.FindingViewSchema.parse(f));
    const r6 = findings.find((f) => f.code === 'R6');
    expect(r6).toMatchObject({ severity: 'warning', subject: { type: 'unit', id: unitId } });
    expect((await owner.call('POST', `/org/findings/${r6!.id}/accept`, {})).status).toBe(400);
    const accepted = await owner.call('POST', `/org/findings/${r6!.id}/accept`, {
      reason: 'one-person unit',
    });
    expect(accepted.status).toBe(201);
    expect((accepted.body as { status: string }).status).toBe('accepted');
    expect((await owner.call('GET', `/org/findings/${r6!.id}`)).status).toBe(200);

    const outsider = await signedIn(null, null);
    expect((await outsider.call('GET', `/org/findings?companyId=${companyId}`)).status).toBe(403);
    expect((await outsider.call('POST', `/org/companies/${companyId}/rule-runs`)).status).toBe(403);
  });

  it('changes the structure over HTTP: change request, approval, correction', async () => {
    const owner = await signedIn('org_data_owner', null);
    const approver = await signedIn('org_change_approver', null);
    const submitted = await owner.call('POST', '/org/change-requests', {
      companyId,
      effectiveDate: '2026-12-20',
      reason: 'rename the root unit',
      operations: [{ op: 'unit.update', unitId, changes: { nameFa: 'ستاد' } }],
    });
    expect(submitted.status).toBe(201);
    const request = orgV1.ChangeRequestViewSchema.parse(submitted.body);
    expect(
      (
        await owner.call('POST', '/org/change-requests', {
          companyId,
          effectiveDate: '2026-12-20',
          reason: 'x',
          operations: [],
        })
      ).status,
    ).toBe(400);
    expect(
      (await approver.call('POST', `/platform/approvals/${request.approvalRequestId}/approve`, {}))
        .status,
    ).toBe(201);
    const applied = await owner.call('GET', `/org/change-requests/${request.id}`);
    expect((applied.body as { status: string }).status).toBe('applied');

    const corrected = await owner.call('POST', `/org/positions/${pos.staff}/corrections`, {
      versionFrom: '2020-01-01',
      changes: { titleEn: 'Specialist' },
      reason: 'English title was missing',
    });
    expect(corrected.status).toBe(201);
    expect(
      (
        await owner.call('POST', `/org/positions/${pos.staff}/corrections`, {
          versionFrom: '2020-01-01',
          changes: { unitId },
          reason: 'structure is not a correction',
        })
      ).status,
    ).toBe(400);
  });
});

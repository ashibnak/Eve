import { ForbiddenException } from '@nestjs/common';
import ExcelJS from 'exceljs';
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
import { OrgFixture } from './org.fixture';

const ON = '2026-11-22' as platformV1.BusinessDate;

/** S9 reads for the web UI: my companies and permissions, position history, export. */
describe('org workspace reads (S9)', () => {
  let platform: Platform;
  let hr: ReturnType<typeof createHr>;
  let companyId: string;
  const pos: Record<string, string> = {};
  const per: Record<string, string> = {};
  const users: Record<string, string> = {};

  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });
  const run = <T>(user: string, fn: () => Promise<T>) =>
    asUser(fn, as(users[user]!)).then((r) => r.result);

  async function user(role: string | null, scope: 'company' | 'customer' = 'company') {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('ws'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'workspace test',
      }),
    );
    if (role) {
      await asUser(() =>
        platform.users.grantRole({
          userId: result.id,
          role,
          scopeKind: scope,
          companyId: scope === 'company' ? companyId : null,
          unitId: null,
          reason: 't',
        }),
      );
    }
    return result.id;
  }

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    hr = createHr(platform);
    await ensureTimeZone(platform);
    companyId = (
      await asUser(() =>
        platform.companies.register({
          code: uniqueCompanyCode('WS'),
          jurisdictionCode: 'ir',
          reason: 't',
        }),
      )
    ).result.id;
    const f = new OrgFixture(companyId, `W${Date.now().toString(36).toUpperCase()}`.slice(0, 10));
    const root = f.unit('ستاد');
    pos.head = f.position(root, 'مدیرعامل', { supervisory: true });
    pos.staff = f.position(root, 'کارشناس', { reportsTo: pos.head });
    f.supervise(root, pos.head);
    per.head = f.person();
    per.staff = f.person();
    f.assign(per.head, pos.head);
    f.assign(per.staff, pos.staff, 'primary', { to: '2025-01-01' });
    per.next = f.person();
    f.assign(per.next, pos.staff, 'primary', { from: '2025-01-01' });
    await f.save(platform);

    users.owner = await user('org_data_owner');
    users.approver = await user('org_change_approver', 'customer');
    users.employee = await user(null);
    users.outsider = await user(null);
    await platform.prisma.peopleUserLink.create({
      data: { userId: users.employee, personId: per.next, companyId, linkedAt: new Date() },
    });
  }, 120_000);

  afterAll(() => platform.close());

  it('lists the companies each user works in, with what they may do there', async () => {
    const owner = (await run('owner', () => hr.workspace.companies())).find(
      (c) => c.companyId === companyId,
    )!;
    orgV1.CompanyWorkspaceSchema.parse(owner);
    expect(owner.can).toMatchObject({
      readStructure: true,
      manageFindings: true,
      importStructure: true,
      requestChange: true,
      correct: true,
      approveChange: false,
      manageCompany: false,
    });
    const approver = (await run('approver', () => hr.workspace.companies())).find(
      (c) => c.companyId === companyId,
    )!;
    expect(approver.can).toMatchObject({
      readStructure: true,
      approveChange: true,
      requestChange: false,
    });
    const employee = await run('employee', () => hr.workspace.companies());
    expect(employee).toHaveLength(1);
    expect(employee[0]).toMatchObject({
      companyId,
      myPersonId: per.next,
      can: { readStructure: false },
    });
    expect(await run('outsider', () => hr.workspace.companies())).toEqual([]);
  });

  it("shows a position's dated history to org readers only", async () => {
    const history = orgV1.PositionHistorySchema.parse(
      await run('owner', () => hr.workspace.history(pos.staff!)),
    );
    expect(history.lines).toEqual([
      expect.objectContaining({
        kind: 'direct',
        toPositionId: pos.head,
        validFrom: '2020-01-01',
        validTo: null,
      }),
    ]);
    expect(history.assignments.map((a) => [a.personId, a.validFrom, a.validTo])).toEqual([
      [per.staff, '2020-01-01', '2025-01-01'],
      [per.next, '2025-01-01', null],
    ]);
    expect(history.assignments[0]!.name).not.toBeNull();
    await expect(run('employee', () => hr.workspace.history(pos.staff!))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('filters findings by subject, for the position card', async () => {
    await run('owner', () => hr.rules.runner.runNow(companyId));
    const all = await run('owner', () => hr.rules.findings.list({ companyId, severity: 'info' }));
    const subject = all[0]!.subject.id;
    const mine = await run('owner', () =>
      hr.rules.findings.list({ companyId, severity: 'info', subjectId: subject }),
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((f) => f.subject.id === subject)).toBe(true);
  });

  it('exports the positions table as an Excel file with localized headers', async () => {
    const content = await run('owner', () => hr.workspace.positionsWorkbook(companyId, ON));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(content as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.name).toBe('پست‌ها');
    expect(sheet.getRow(1).getCell(1).value).toBe('کد پست');
    expect(sheet.rowCount).toBe(3);
    const english = await run('owner', () => hr.workspace.positionsWorkbook(companyId, ON, 'en'));
    const en = new ExcelJS.Workbook();
    await en.xlsx.load(english as unknown as ArrayBuffer);
    expect(en.worksheets[0]!.getRow(1).getCell(1).value).toBe('Position code');
    await expect(
      run('employee', () => hr.workspace.positionsWorkbook(companyId, ON)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

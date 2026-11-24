import { ConflictException, ForbiddenException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { peopleV1, type platformV1 } from '@eve/contracts';
import {
  asUser,
  createPlatform,
  ensureTimeZone,
  type Platform,
  rawClient,
  uniqueCompanyCode,
  uniqueUsername,
} from '../../../../../test/platform';
import {
  createPeople,
  type FixturePerson,
  generatePeopleFile,
  PEOPLE_HEADERS,
} from './people.harness';

const LOAD_DATE = '2026-11-22' as platformV1.BusinessDate; // 1 Azar 1405

describe('people core (S4 done-when: both companies import cleanly)', () => {
  let platform: Platform;
  let people: ReturnType<typeof createPeople>;
  const companies: Record<'a' | 'b', { id: string; owner: string; file: FixturePerson[] }> = {
    a: { id: '', owner: '', file: [] },
    b: { id: '', owner: '', file: [] },
  };
  let admin: string;
  let auditor: string;

  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });

  async function person(role: string, companyId: string | null) {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('ppl'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'people test',
      }),
    );
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
    return result.id;
  }

  /** Runs a people file through the whole S3 pipeline as the company's data owner. */
  async function importFile(
    key: 'a' | 'b',
    content: Buffer,
    effectiveDate = LOAD_DATE,
    commit = true,
  ) {
    const company = companies[key];
    const run = <T>(fn: () => Promise<T>) => asUser(fn, as(company.owner)).then((r) => r.result);
    const uploaded = await run(() =>
      platform.imports.upload({
        target: 'people.person',
        companyId: company.id,
        effectiveDate,
        sourceName: 'payroll-export',
        fileName: 'people.xlsx',
        content,
      }),
    );
    await run(() => platform.imports.map(uploaded.id, uploaded.mapping, true));
    await run(() => platform.imports.validate(uploaded.id));
    const preview = await run(() => platform.imports.preview(uploaded.id));
    if (commit) await run(() => platform.imports.commit(preview.id, 'people load'));
    return preview;
  }

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    people = createPeople(platform);
    await ensureTimeZone(platform);
    for (const key of ['a', 'b'] as const) {
      companies[key].id = (
        await asUser(() =>
          platform.companies.register({
            code: uniqueCompanyCode(key.toUpperCase()),
            jurisdictionCode: 'ir',
            reason: 't',
          }),
        )
      ).result.id;
      companies[key].owner = await person('people_data_owner', companies[key].id);
    }
    admin = await person('system_admin', null);
    auditor = await person('auditor', null);
  }, 120_000);

  afterAll(() => platform.close());

  it(
    'imports 1,200 and 800 generated people with no blocking finding',
    { timeout: 300_000 },
    async () => {
      for (const [key, count, seed] of [
        ['a', 1200, 7],
        ['b', 800, 11],
      ] as const) {
        const { content, people: file } = await generatePeopleFile(count, seed);
        companies[key].file = file;
        const preview = await importFile(key, content);
        expect(preview.counts).toMatchObject({
          rows: count,
          rowsWithErrors: 0,
          added: count,
          changed: 0,
        });
        expect((preview.findings ?? []).filter((f) => f.severity === 'blocking')).toEqual([]);

        const expectedActive = file.filter((p) => p.status !== 'suspended').length;
        const active = await asUser(
          () => people.service.listActive(companies[key].id, { asOf: LOAD_DATE }),
          as(companies[key].owner),
        );
        expect(active.result).toHaveLength(expectedActive);
        // Service output satisfies the published people/v1 contract.
        for (const view of active.result.slice(0, 50)) peopleV1.PersonViewSchema.parse(view);
      }
    },
  );

  it('normalized the messy cells: Persian letters and digits, dates, status words', async () => {
    const all = await asUser(
      () => people.service.list(companies.a.id, { asOf: LOAD_DATE, limit: 5000 }),
      as(companies.a.owner),
    );
    expect(all.result).toHaveLength(1200);
    for (const p of all.result) {
      expect(p.personnelCode).toMatch(/^\d+$/);
      expect(`${p.name.first.fa}${p.name.last.fa}`).not.toMatch(/[يك]/);
      expect(p.hireDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (p.contact) expect(p.contact.address).toMatch(/^09\d{9}$/);
    }
    // Before the first load the register knows no status (it does not invent history).
    const before = await asUser(
      () =>
        people.service.getPerson(all.result[0]!.id, {
          asOf: '2026-11-21' as platformV1.BusinessDate,
        }),
      as(companies.a.owner),
    );
    expect(before.result?.status).toBeNull();
  });

  it('re-imports with changes: added, changed and not-in-file, without touching the missing', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('پرسنل');
    ws.addRow(PEOPLE_HEADERS);
    const [first, second, third, , fifth] = companies.b.file;
    ws.addRow([first!.code, 'نیما', 'افشار', '', '1400/01/15', 'قطع همکاری', '', '']); // name + status change
    ws.addRow([second!.code, 'x', 'y', '', '1400/01/15', 'مرخصی', '', '']);
    ws.addRow([third!.code, 'x', 'y', '', '1400/01/15', 'فعال', '', '']);
    ws.addRow(['99999', 'تازه', 'وارد', '', '1405/09/10', 'فعال', 'بله', '09125556666']);
    const effective = '2026-12-01' as platformV1.BusinessDate;
    const preview = await importFile(
      'b',
      Buffer.from(await wb.xlsx.writeBuffer()),
      effective,
      false,
    );
    expect(preview.counts).toMatchObject({ added: 1, changed: 3 });
    const notInFile = (preview.findings ?? []).filter((f) => f.code === 'not_in_file');
    expect(notInFile).toHaveLength(800 - 3);
    expect(notInFile.find((f) => f.key === fifth!.code)?.severity).toBe('warning');

    await asUser(
      () => platform.imports.commit(preview.id, 'December changes'),
      as(companies.b.owner),
    );
    const leaver = await asUser(
      () => people.service.findByPersonnelCode(companies.b.id, first!.code, { asOf: effective }),
      as(companies.b.owner),
    );
    expect(leaver.result).toMatchObject({ status: 'terminated', name: { first: { fa: 'نیما' } } });
    const dayBefore = await asUser(
      () =>
        people.service.findByPersonnelCode(companies.b.id, first!.code, {
          asOf: '2026-11-30' as platformV1.BusinessDate,
        }),
      as(companies.b.owner),
    );
    expect(dayBefore.result?.status).toBe(first!.status);
    // Not in the file: unchanged.
    const untouched = await asUser(
      () => people.service.findByPersonnelCode(companies.b.id, fifth!.code, { asOf: effective }),
      as(companies.b.owner),
    );
    expect(untouched.result?.status).toBe(fifth!.status);

    const audit = await platform.prisma.auditLog.findMany({
      where: { actionId: preview.id },
      select: { action: true, source: true },
    });
    expect(audit.every((a) => a.source === 'file')).toBe(true);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'people.person.create',
        'people.person.correct',
        'people.person.status_change',
        'platform.import.commit',
      ]),
    );
  });

  it('keeps an effective-dated status history and refuses changes before a later one', async () => {
    // Someone active on the load date, so both changes below are real changes.
    const p = companies.a.file.find((x) => x.status === 'active');
    const owner = as(companies.a.owner);
    const view = (
      await asUser(() => people.service.findByPersonnelCode(companies.a.id, p!.code), owner)
    ).result!;
    const d1 = '2026-12-10' as platformV1.BusinessDate;
    const d2 = '2027-01-05' as platformV1.BusinessDate;
    await asUser(() => people.commands.changeStatus(view.id, 'on_leave', d1, 'long leave'), owner);
    await asUser(() => people.commands.changeStatus(view.id, 'terminated', d2, 'resigned'), owner);

    const statusOn = async (asOf: string) =>
      (
        await asUser(
          () => people.service.getPerson(view.id, { asOf: asOf as platformV1.BusinessDate }),
          owner,
        )
      ).result?.status;
    expect(await statusOn('2026-12-09')).toBe(p!.status);
    expect(await statusOn('2026-12-10')).toBe('on_leave');
    expect(await statusOn('2027-01-04')).toBe('on_leave');
    expect(await statusOn('2027-01-05')).toBe('terminated');

    const activeOn = async (asOf: string) =>
      (
        await asUser(
          () =>
            people.service.listActive(companies.a.id, { asOf: asOf as platformV1.BusinessDate }),
          owner,
        )
      ).result.some((x) => x.id === view.id);
    expect(await activeOn('2026-12-20')).toBe(true); // on leave still counts
    expect(await activeOn('2027-01-05')).toBe(false);

    await expect(
      asUser(
        () =>
          people.commands.changeStatus(
            view.id,
            'active',
            '2026-12-20' as platformV1.BusinessDate,
            'oops',
          ),
        owner,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      asUser(() => people.commands.changeStatus(view.id, 'active', d2, 'same day'), owner),
    ).rejects.toThrow('already starts');
    expect(
      (
        await asUser(
          () =>
            people.commands.changeStatus(
              view.id,
              'terminated',
              '2027-02-01' as platformV1.BusinessDate,
              'no-op',
            ),
          owner,
        )
      ).result,
    ).toBe(false);

    const events = await platform.prisma.eventsOutbox.findMany({
      where: {
        type: 'people.person.status_changed',
        payload: { path: ['person_id'], equals: view.id },
      },
    });
    expect(events.map((e) => e.effectiveAt.toISOString().slice(0, 10))).toEqual([d1, d2]);
  });

  it('enforces the history in the database: no overlap, no rewriting', async () => {
    const owner = await rawClient(inject('db').ownerUrl);
    const app = await rawClient(inject('db').appUrl);
    try {
      const { rows } = await owner.query<{ person_id: string; company_id: string }>(
        'SELECT person_id, company_id FROM people_employment_status LIMIT 1',
      );
      const row = rows[0]!;
      await expect(
        owner.query(
          `INSERT INTO people_employment_status (person_id, company_id, status, valid_from, recorded_at) VALUES ($1, $2, 'active', '2000-01-01', now())`,
          [row.person_id, row.company_id],
        ),
      ).rejects.toThrow(/people_employment_status_no_overlap/);
      await expect(
        app.query(`UPDATE people_employment_status SET status = 'active'`),
      ).rejects.toThrow(/permission denied/);
      await expect(app.query('DELETE FROM people_person')).rejects.toThrow(/permission denied/);
    } finally {
      await owner.end();
      await app.end();
    }
  });

  it('keeps each data owner to their company; admins and auditors see no people', async () => {
    const bPerson = (
      await asUser(
        () => people.service.findByPersonnelCode(companies.b.id, companies.b.file[3]!.code),
        as(companies.b.owner),
      )
    ).result!;
    expect(
      (await asUser(() => people.service.getPerson(bPerson.id), as(companies.a.owner))).result,
    ).toBeNull();
    await expect(
      asUser(() => people.service.listActive(companies.b.id), as(companies.a.owner)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      asUser(
        () =>
          people.commands.changeStatus(
            bPerson.id,
            'suspended',
            '2027-03-01' as platformV1.BusinessDate,
            'x',
          ),
        as(companies.a.owner),
      ),
    ).rejects.toThrow('not found');
    await expect(
      asUser(() => people.service.listActive(companies.a.id), as(admin)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      asUser(() => people.service.getPerson(bPerson.id), as(auditor)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('corrects identity fields with an audit row, and reports a no-op', async () => {
    const owner = as(companies.a.owner);
    const target = (
      await asUser(
        () => people.service.findByPersonnelCode(companies.a.id, companies.a.file[5]!.code),
        owner,
      )
    ).result!;
    expect(
      (
        await asUser(
          () =>
            people.commands.correct(
              target.id,
              { lastNameFa: 'صادقی', lastNameEn: 'Sadeghi' },
              'typo in surname',
            ),
          owner,
        )
      ).result,
    ).toBe(true);
    expect(
      (
        await asUser(
          () => people.commands.correct(target.id, { lastNameFa: 'صادقی' }, 'again'),
          owner,
        )
      ).result,
    ).toBe(false);
    const audit = await platform.prisma.auditLog.findFirstOrThrow({
      where: { entityId: target.id, action: 'people.person.correct' },
    });
    expect(audit.after).toEqual({ lastNameFa: 'صادقی', lastNameEn: 'Sadeghi' });
  });
});

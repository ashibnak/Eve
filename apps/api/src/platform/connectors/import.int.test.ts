import { ConflictException, ForbiddenException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
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
import { widgetTarget, WidgetImporterRole } from '../../../test/widget-target';

type Row = (string | number | Date)[];

async function xlsx(rows: Row[], sheet = 'ابزارها'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(['کد', 'نام', 'قیمت', 'تاریخ عرضه']);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('file import pipeline (S3 done-when)', () => {
  let platform: Platform;
  let companyId: string;
  let otherCompany: string;
  let importer: string;
  let outsider: string;
  let approver: string;
  const effectiveDate = '2026-11-22' as platformV1.BusinessDate;

  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });
  const asImporter = <T>(fn: () => Promise<T>) => asUser(fn, as(importer)).then((r) => r.result);

  async function person(role: string, companyScope: string | null): Promise<string> {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('imp'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'import test',
      }),
    );
    await asUser(() =>
      platform.users.grantRole({
        userId: result.id,
        role,
        scopeKind: companyScope ? 'company' : 'customer',
        companyId: companyScope,
        unitId: null,
        reason: 't',
      }),
    );
    return result.id;
  }

  const upload = (
    content: Buffer,
    fileName = 'widgets.xlsx',
    target = 'test.widget',
    company = companyId,
  ) =>
    asImporter(() =>
      platform.imports.upload({
        target,
        companyId: company,
        effectiveDate,
        sourceName: 'warehouse',
        fileName,
        content,
      }),
    );

  const MAPPING = {
    ابزارها: {
      entity: 'widget',
      columns: { کد: 'code', نام: 'name', قیمت: 'price', 'تاریخ عرضه': 'launched' },
    },
  };

  async function runToPreview(content: Buffer, target = 'test.widget', fileName = 'widgets.xlsx') {
    const uploaded = await upload(content, fileName, target);
    await asImporter(() => platform.imports.map(uploaded.id, uploaded.mapping ?? MAPPING, true));
    await asImporter(() => platform.imports.validate(uploaded.id));
    return asImporter(() => platform.imports.preview(uploaded.id));
  }

  const widgets = () =>
    platform.prisma.$queryRaw<{ code: string; name: string; price: number }[]>`
      SELECT code, name, price FROM test_widget WHERE company_id = ${companyId}::uuid ORDER BY code`;

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    platform.roles.register(WidgetImporterRole);
    platform.imports.registerTarget(widgetTarget(platform.prisma, platform.audit));
    platform.imports.registerTarget(
      widgetTarget(platform.prisma, platform.audit, {
        name: 'test.gated_widget',
        approvalChain: ['rule_approver'],
      }),
    );
    await ensureTimeZone(platform);
    const register = (code: string) =>
      asUser(() => platform.companies.register({ code, jurisdictionCode: 'ir', reason: 't' })).then(
        (r) => r.result.id,
      );
    companyId = await register(uniqueCompanyCode('W'));
    otherCompany = await register(uniqueCompanyCode('X'));
    importer = await person(WidgetImporterRole.name, companyId);
    outsider = await person(WidgetImporterRole.name, otherCompany);
    approver = await person('rule_approver', null);
  });

  afterAll(() => platform.close());

  it('uploads, maps, validates, previews and commits a sheet with full audit', async () => {
    const content = await xlsx([
      ['W-1', 'پيچ', 1000, '1405/09/01'],
      ['W-2', 'مهره', '۲٬۵۰۰', new Date(Date.UTC(2026, 10, 1))],
      ['W-3', 'واشر', 300, ''],
    ]);
    const uploaded = await upload(content);
    expect(uploaded).toMatchObject({
      status: 'uploaded',
      file: { sha256: createHash('sha256').update(content).digest('hex'), format: 'xlsx' },
      sheets: [{ name: 'ابزارها', rowCount: 3 }],
    });
    // Headers matched the fields' Persian aliases automatically.
    expect(uploaded.mapping).toEqual(MAPPING);

    const mapped = await asImporter(() =>
      platform.imports.map(uploaded.id, uploaded.mapping, true),
    );
    expect(mapped).toMatchObject({ status: 'mapped', counts: { rows: 3, rowsWithErrors: 0 } });
    const validated = await asImporter(() => platform.imports.validate(uploaded.id));
    expect(validated.findings).toEqual([]);
    const previewed = await asImporter(() => platform.imports.preview(uploaded.id));
    expect(previewed.counts).toMatchObject({ added: 3, changed: 0, removed: 0, unchanged: 0 });
    expect(previewed.diff?.[0]?.after).toEqual({
      code: 'W-1',
      name: 'پیچ',
      price: 1000,
      launched: '2026-11-22',
    });

    const committed = await asUser(
      () => platform.imports.commit(uploaded.id, 'initial load'),
      as(importer),
    );
    expect(committed.result.status).toBe('committed');
    expect(await widgets()).toEqual([
      { code: 'W-1', name: 'پیچ', price: 1000 },
      { code: 'W-2', name: 'مهره', price: 2500 },
      { code: 'W-3', name: 'واشر', price: 300 },
    ]);

    // Every change is audited as source "file" with the import as action id, plus the import itself.
    const audit = await platform.prisma.auditLog.findMany({
      where: { actionId: uploaded.id },
      orderBy: { seq: 'asc' },
    });
    expect(audit.map((a) => [a.action, a.source])).toEqual([
      ['test.widget.create', 'file'],
      ['test.widget.create', 'file'],
      ['test.widget.create', 'file'],
      ['platform.import.commit', 'file'],
    ]);
    expect(audit.every((a) => a.correlationId === committed.correlationId)).toBe(true);
    expect(audit.at(-1)?.after).toMatchObject({ sha256: uploaded.file.sha256, added: 3 });
    const events = await platform.prisma.eventsOutbox.findMany({
      where: { correlationId: committed.correlationId },
    });
    expect(events.map((e) => e.type)).toEqual(['platform.import.committed']);
    // The file is kept as evidence and still matches its hash.
    expect(
      createHash('sha256')
        .update(await platform.files.get(uploaded.file.sha256))
        .digest('hex'),
    ).toBe(uploaded.file.sha256);
  });

  it('pre-maps the next import from the same source and shows every kind of difference', async () => {
    const preview = await runToPreview(
      await xlsx([
        ['W-1', 'پیچ', 1000, '1405/09/01'], // unchanged
        ['W-2', 'مهره', 2600, '2026-11-01'], // changed
        ['W-4', 'میخ', 50, ''], // added
        // W-3 missing → removed
      ]),
    );
    expect(preview.counts).toMatchObject({ added: 1, changed: 1, removed: 1, unchanged: 1 });
    expect(preview.diff?.find((d) => d.kind === 'changed')).toMatchObject({
      key: 'W-2',
      before: { price: 2500 },
      after: { price: 2600 },
    });
  });

  it('refuses to commit with row errors or blocking findings; warnings are fine', async () => {
    const withErrors = await runToPreview(await xlsx([['W-9', 'پیچ تازه', 'گران', '1405/13/01']]));
    expect(withErrors.counts.rowsWithErrors).toBe(1);
    expect(withErrors.rowErrors[0]?.errors).toEqual([
      { field: 'price', message: 'price: "گران" is not a number' },
      { field: 'launched', message: 'launched: "1405/13/01" is not a valid date' },
    ]);
    await expect(
      asImporter(() => platform.imports.commit(withErrors.id, 'x')),
    ).rejects.toBeInstanceOf(ConflictException);

    const duplicateName = await runToPreview(
      await xlsx([
        ['W-7', 'یکسان', 1, ''],
        ['W-8', 'يکسان', 1, ''],
      ]),
    );
    expect(duplicateName.findings?.map((f) => f.code)).toContain('duplicate_name');
    await expect(asImporter(() => platform.imports.commit(duplicateName.id, 'x'))).rejects.toThrow(
      'blocking',
    );

    const priceDrop = await runToPreview(await xlsx([['W-1', 'پیچ', 10, '']]));
    expect(priceDrop.findings).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'price_drop' }),
    ]);
  });

  it('flags a key that appears twice in the file', async () => {
    const preview = await runToPreview(
      await xlsx([
        ['W-5', 'الف', 1, ''],
        ['W-5', 'ب', 2, ''],
      ]),
    );
    expect(preview.rowErrors).toEqual([
      expect.objectContaining({
        rowNumber: 3,
        errors: [{ field: 'code', message: 'code "W-5" also appears in row 2' }],
      }),
    ]);
  });

  it('needs a fresh preview after re-mapping, and refuses if data changed since the preview', async () => {
    const preview = await runToPreview(await xlsx([['W-6', 'میله', 70, '']]));
    await asImporter(() => platform.imports.map(preview.id, MAPPING, false));
    await expect(asImporter(() => platform.imports.commit(preview.id, 'x'))).rejects.toThrow(
      'expected previewed',
    );

    await asImporter(() => platform.imports.validate(preview.id));
    await asImporter(() => platform.imports.preview(preview.id));
    await platform.prisma.$executeRaw`
      INSERT INTO test_widget (company_id, code, name, price) VALUES (${companyId}::uuid, 'W-6', 'میله', 1)`;
    await expect(asImporter(() => platform.imports.commit(preview.id, 'x'))).rejects.toThrow(
      'changed since the preview',
    );
  });

  it("keeps imports to the importer's companies and permission", async () => {
    const content = await xlsx([['Z-1', 'z', 1, '']]);
    await expect(
      asUser(
        () =>
          platform.imports.upload({
            target: 'test.widget',
            companyId,
            effectiveDate,
            sourceName: 's',
            fileName: 'z.xlsx',
            content,
          }),
        as(outsider),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const mine = await upload(content);
    await expect(asUser(() => platform.imports.get(mine.id), as(outsider))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(asUser(() => platform.imports.get(mine.id), as(approver))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects files over the limit, of the wrong type, or without data', async () => {
    await expect(upload(Buffer.alloc(21 * 1024 * 1024), 'big.xlsx')).rejects.toThrow('limit');
    await expect(upload(Buffer.from('a,b'), 'old.xls')).rejects.toThrow('.xls');
    await expect(upload(Buffer.from('not excel'), 'broken.xlsx')).rejects.toThrow(
      'could not be read',
    );
  });

  it('reads UTF-8 CSV with Persian digits and Jalali dates', async () => {
    const csv = Buffer.from('کد,نام,قیمت,تاریخ عرضه\nC-1,كتاب,۱۲۰۰,۱۴۰۵/۰۹/۰۱\n', 'utf8');
    const uploaded = await upload(csv, 'books.csv');
    expect(uploaded.sheets[0]?.name).toBe('csv');
    const mapping = { csv: { entity: 'widget', columns: MAPPING.ابزارها.columns } };
    await asImporter(() => platform.imports.map(uploaded.id, mapping, false));
    await asImporter(() => platform.imports.validate(uploaded.id));
    const preview = await asImporter(() => platform.imports.preview(uploaded.id));
    expect(preview.diff?.find((d) => d.key === 'C-1')?.after).toEqual({
      code: 'C-1',
      name: 'کتاب',
      price: 1200,
      launched: '2026-11-22',
    });
  });

  it('routes the commit through approval when the target asks for it', async () => {
    const preview = await runToPreview(await xlsx([['G-1', 'دروازه', 5, '']]), 'test.gated_widget');
    const pending = await asImporter(() => platform.imports.commit(preview.id, 'needs approval'));
    expect(pending.status).toBe('awaiting_approval');
    expect((await widgets()).some((w) => w.code === 'G-1')).toBe(false);

    await asUser(
      () => platform.approvals.approve(pending.approvalRequestId as string, 'ok'),
      as(approver),
    );
    expect((await asImporter(() => platform.imports.get(preview.id))).status).toBe('committed');
    expect((await widgets()).some((w) => w.code === 'G-1')).toBe(true);
  });

  it('purges discarded and abandoned imports after 30 days, but keeps committed files', async () => {
    const discarded = await upload(await xlsx([['P-1', 'موقت', 1, '']]));
    await asImporter(() => platform.imports.map(discarded.id, MAPPING, false));
    await asImporter(() => platform.imports.discard(discarded.id, 'wrong file'));
    const committedSha = (
      await platform.prisma.connectorsImport.findFirstOrThrow({
        where: { status: 'committed', companyId },
      })
    ).fileSha256;

    // Other test files share this database: look at this file's import, not the global count.
    const own = () =>
      platform.prisma.connectorsImport.findUniqueOrThrow({ where: { id: discarded.id } });
    platform.clock.advance(29 * 86_400_000);
    await platform.imports.purgeExpired();
    expect((await own()).purgedAt).toBeNull();
    platform.clock.advance(2 * 86_400_000);
    try {
      expect(await platform.imports.purgeExpired()).toBeGreaterThan(0);
    } finally {
      platform.clock.reset();
    }
    const purged = await platform.prisma.connectorsImport.findUniqueOrThrow({
      where: { id: discarded.id },
    });
    expect(purged).toMatchObject({ status: 'discarded', fileRef: null });
    expect(purged.purgedAt).not.toBeNull();
    expect(
      await platform.prisma.connectorsImportRow.count({ where: { importId: discarded.id } }),
    ).toBe(0);
    await expect(platform.files.get(discarded.file.sha256)).rejects.toThrow();
    await expect(platform.files.get(committedSha)).resolves.toBeInstanceOf(Buffer);
  });
});

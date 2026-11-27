import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ForbiddenException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';
import {
  asUser,
  createPlatform,
  ensureHomeJurisdiction,
  ensureTimeZone,
  type Platform,
  uniqueCompanyCode,
  uniqueUsername,
} from '../../../test/platform';
import { DocumentSetupError } from './document.service';
import { LetterheadSetting } from './letterhead';
import { SampleNoticeV1 } from './sample/sample-notice.template';
import { defineDocumentTemplate } from './template';

const NOW = new Date('2026-11-27T08:00:00Z');
const data = {
  recipient: 'کارکنان محترم',
  subject: 'ابلاغ ساعت کاری زمستان',
  effectiveDate: '2026-12-22',
  items: [
    { title: 'شروع کار ساعت ۸', note: null },
    { title: 'پایان کار ساعت ۱۶', note: 'پنج‌شنبه‌ها ۱۳' },
  ],
};
// A tiny valid PNG (1×1).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('issued documents (S11)', () => {
  let platform: Platform;
  let companyA: string;
  let companyB: string;
  const users: Record<string, string> = {};
  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });

  async function user(role: string, companyId: string | null) {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('doc'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'documents test',
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

  const issue = (
    companyId: string,
    overrides: Partial<Parameters<Platform['documents']['issue']>[0]> = {},
  ) =>
    asUser(() =>
      platform.documents.issue({
        companyId,
        template: SampleNoticeV1,
        data,
        language: 'fa',
        number: 'FNP/1405/000123',
        reason: 'ابلاغ',
        ...overrides,
      }),
    );

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    await ensureTimeZone(platform);
    await ensureHomeJurisdiction(platform);
    platform.clock.setTime(NOW);
    companyA = await register('DA');
    companyB = await register('DB');
    for (const companyId of [companyA, companyB]) {
      await asUser(() =>
        platform.config.set({
          setting: LetterheadSetting,
          companyId,
          value: {
            nameFa: 'شرکت نمونهٔ فناوری',
            nameEn: 'Sample Technology Co.',
            addressFa: 'تهران، خیابان ولیعصر، پلاک ۱',
            phone: '021-88000000',
          },
          reason: 'letterhead',
        }),
      );
    }
    users.auditorA = await user('auditor', companyA);
    users.admin = await user('system_admin', null);
  }, 120_000);

  afterAll(async () => {
    platform.clock.reset();
    await platform.close();
  });

  it('issues a Persian document: record, audit row and event together, file kept', async () => {
    const { result, correlationId } = await issue(companyA);
    const row = await platform.prisma.docDocument.findUniqueOrThrow({
      where: { id: result.documentId },
    });
    expect(row).toMatchObject({
      templateId: 'platform.sample_notice',
      templateVersion: 1,
      layoutId: 'ir.letter',
      layoutVersion: 1,
      language: 'fa',
      number: 'FNP/1405/000123',
      fileRef: result.fileRef,
      inputsHash: result.inputsHash,
      source: 'manual',
      correlationId,
    });
    expect(result.issuedOn).toBe('2026-11-27');

    const audit = await platform.prisma.auditLog.findMany({
      where: { entityId: result.documentId },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'platform.document.issue', reason: 'ابلاغ' });
    const events = await platform.prisma.eventsOutbox.findMany({
      where: { type: 'platform.document.issued', correlationId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      document_id: result.documentId,
      file_sha256: result.fileRef,
    });

    const pdf = await platform.files.get(result.fileRef);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/Vazirmatn/);
    expect(pdf.toString('latin1')).toContain("/CreationDate (D:20261127000000+00'00')");
  });

  it('gives the same bytes for the same inputs, different bytes for different data', async () => {
    const first = await issue(companyA);
    const second = await issue(companyA);
    expect(second.result.documentId).not.toBe(first.result.documentId);
    expect(second.result.inputsHash).toBe(first.result.inputsHash);
    expect(second.result.fileRef).toBe(first.result.fileRef);
    expect(
      (await platform.files.get(second.result.fileRef)).equals(
        await platform.files.get(first.result.fileRef),
      ),
    ).toBe(true);

    const other = await issue(companyA, { data: { ...data, recipient: 'همکاران گرامی' } });
    expect(other.result.fileRef).not.toBe(first.result.fileRef);
    const english = await issue(companyA, { language: 'en' });
    expect(english.result.fileRef).not.toBe(first.result.fileRef);
  });

  it('refuses invalid data, a missing language and a company without a letterhead', async () => {
    await expect(issue(companyA, { data: { ...data, items: 'x' } })).rejects.toThrow(
      /Data for platform.sample_notice@1/,
    );
    const faOnly = defineDocumentTemplate({
      id: 'test.fa_only',
      version: 1,
      schema: z.object({}),
      body: { fa: '<p>متن</p>' },
    });
    await expect(issue(companyA, { template: faOnly, data: {}, language: 'en' })).rejects.toThrow(
      /no en version/,
    );
    const bare = await register('DN');
    await expect(issue(bare)).rejects.toBeInstanceOf(DocumentSetupError);
    await expect(issue(companyA, { reason: ' ' })).rejects.toThrow(/reason/);
  });

  it('loads nothing from the network, even when a template asks', async () => {
    let hits = 0;
    const server: Server = createServer((_req, res) => {
      hits += 1;
      res.end('x');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const sneaky = defineDocumentTemplate({
        id: 'test.remote_image',
        version: 1,
        schema: z.object({ url: z.string() }),
        body: {
          fa: `<p>تصویر</p><img src="{{url}}"><link rel="stylesheet" href="http://127.0.0.1:${port}/s.css">`,
        },
        css: `body { background: url(http://127.0.0.1:${port}/bg.png); }`,
      });
      const before = platform.pdf.blockedRequests;
      await asUser(() =>
        platform.documents.preview({
          companyId: companyA,
          template: sneaky,
          data: { url: `http://127.0.0.1:${port}/a.png` },
          language: 'fa',
        }),
      );
      expect(hits).toBe(0);
      expect(platform.pdf.blockedRequests).toBeGreaterThan(before);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('prints the letterhead logo; refuses anything but PNG or JPEG', async () => {
    const { result: stored } = await asUser(
      () => platform.documents.storeLogo(PNG),
      as(users.admin!),
    );
    await expect(
      asUser(
        () => platform.documents.storeLogo(Buffer.from('<svg onload="x"/>')),
        as(users.admin!),
      ),
    ).rejects.toThrow(/PNG or JPEG/);
    await expect(
      asUser(() => platform.documents.storeLogo(PNG), as(users.auditorA!)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await asUser(() =>
      platform.config.set({
        setting: LetterheadSetting,
        companyId: companyB,
        value: { nameFa: 'شرکت ب', logoFileRef: stored.logoFileRef },
        reason: 'logo',
      }),
    );
    const { result } = await issue(companyB);
    expect((await platform.files.get(result.fileRef)).toString('latin1')).toMatch(
      /\/Subtype\s*\/Image/,
    );
  });

  it('lets an auditor read documents of their own company only', async () => {
    const { result: a } = await issue(companyA);
    const { result: b } = await issue(companyB);
    const { result: file } = await asUser(
      () => platform.documents.download(a.documentId),
      as(users.auditorA!),
    );
    expect(file.content.subarray(0, 5).toString()).toBe('%PDF-');
    await expect(
      asUser(() => platform.documents.download(b.documentId), as(users.auditorA!)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // The system administrator sees no business data (S1 decision), documents included.
    await expect(
      asUser(() => platform.documents.download(a.documentId), as(users.admin!)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('renders in well under 2 s once warm', async () => {
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const started = performance.now();
      await asUser(() =>
        platform.documents.preview({
          companyId: companyA,
          template: SampleNoticeV1,
          data,
          language: 'fa',
        }),
      );
      times.push(performance.now() - started);
    }
    const warm = times.slice(1).sort((x, y) => x - y);
    console.log(
      `document render: first ${Math.round(times[0]!)} ms, warm median ${Math.round(warm[2]!)} ms, worst ${Math.round(warm[4]!)} ms`,
    );
    expect(warm[2]).toBeLessThan(2000);
    expect(warm[4]).toBeLessThan(2000);
  });
});

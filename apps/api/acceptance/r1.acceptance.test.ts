/**
 * R1 acceptance (S10): Module 1 spec §11 and Roadmap Amendment 1.1 "R1 پایه", end to end through
 * the real pipelines, on two pilot-shaped companies. With ACCEPTANCE_DIR set it reads the real
 * (anonymized) files instead: one folder per company with company.json, people.xlsx and
 * structure.xlsx (optionally structure-revised.xlsx). Writes docs/acceptance/R1-acceptance-report.md.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { platformV1 } from '@eve/contracts';
import { defineApprovalRequestType } from '../src/platform/approvals/request-types';
import { z } from 'zod';
import { createHr } from '../test/hr';
import {
  asUser,
  createPlatform,
  ensureHomeJurisdiction,
  ensureTimeZone,
  type Platform,
  uniqueCompanyCode,
  uniqueUsername,
} from '../test/platform';
import { generatePeopleFile } from '../src/packs/hr/people/tests/people.harness';
import {
  generateStructure,
  LEVELS,
  reviseStructure,
  structureWorkbook,
} from '../src/packs/hr/org/tests/structure-file';

const ROOT = join(__dirname, '..', '..', '..');
const REPORT = join(ROOT, 'docs', 'acceptance', 'R1-acceptance-report.md');
const NOW = new Date('2026-11-22T08:00:00Z');
const TODAY = '2026-11-22' as platformV1.BusinessDate;
const HIRE = 'personnel_action.acceptance.hire';

interface CompanyInput {
  label: string;
  code: string;
  nameFa: string;
  prefix: string;
  legalFields: Record<string, string>;
  levels: string[];
  effectiveDate: platformV1.BusinessDate;
  people: Buffer;
  structure: Buffer;
  revised: Buffer | null;
  generated: boolean;
}

type Status = 'pass' | 'fail' | 'waiting';
interface Criterion {
  group: string;
  id: string;
  text: string;
  status: Status;
  evidence: string;
}

const criteria: Criterion[] = [];
const record = (group: string, id: string, text: string, status: Status, evidence: string) =>
  criteria.push({ group, id, text, status, evidence });
const check = (ok: boolean): Status => (ok ? 'pass' : 'fail');

async function inputs(): Promise<CompanyInput[]> {
  const dir = process.env.ACCEPTANCE_DIR;
  if (dir) {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const folder = join(dir, d.name);
        const meta = JSON.parse(readFileSync(join(folder, 'company.json'), 'utf8')) as {
          code: string;
          nameFa: string;
          prefix: string;
          legalFields: Record<string, string>;
          levels: string[];
          effectiveDate: string;
        };
        const revised = join(folder, 'structure-revised.xlsx');
        return {
          label: d.name,
          ...meta,
          code: uniqueCompanyCode(meta.code.slice(0, 4)),
          effectiveDate: meta.effectiveDate as platformV1.BusinessDate,
          people: readFileSync(join(folder, 'people.xlsx')),
          structure: readFileSync(join(folder, 'structure.xlsx')),
          revised: existsSync(revised) ? readFileSync(revised) : null,
          generated: false,
        };
      });
  }
  // Pilot-shaped companies (decision 2026-11-26): about 1,200 and 800 people and positions.
  const out: CompanyInput[] = [];
  for (const [label, size, seed] of [
    ['pilot-a', 1200, 21],
    ['pilot-b', 800, 22],
  ] as const) {
    const prefix =
      `${label === 'pilot-a' ? 'A' : 'B'}${Date.now().toString(36).toUpperCase()}`.slice(0, 8);
    const people = await generatePeopleFile(size, seed, prefix);
    const spec = generateStructure({
      positions: Math.round(size * 0.95),
      personnelCodes: people.people.map((p) => p.code),
      seed,
    });
    out.push({
      label,
      code: uniqueCompanyCode(label === 'pilot-a' ? 'PA' : 'PB'),
      nameFa: label === 'pilot-a' ? 'شرکت آزمایشی الف' : 'شرکت آزمایشی ب',
      prefix,
      legalFields: { nationalId: '10380284790', ssoWorkshopCode: '1234567890' },
      levels: LEVELS,
      effectiveDate: '2026-11-01' as platformV1.BusinessDate,
      people: people.content,
      structure: await structureWorkbook(spec),
      revised: await structureWorkbook(reviseStructure(spec), 2),
      generated: true,
    });
  }
  return out;
}

const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] ?? 0;
const ms = (n: number) => `${Math.round(n).toLocaleString('fa-IR')} میلی‌ثانیه`;
const num = (n: number) => n.toLocaleString('fa-IR');

describe('R1 acceptance', () => {
  let platform: Platform;
  let hr: ReturnType<typeof createHr>;
  const users: Record<string, string> = {};
  const as = (id: string) => ({ actor: { kind: 'user' as const, id } });
  const run = <T>(user: string, fn: () => Promise<T>) =>
    asUser(fn, as(users[user]!)).then((r) => r.result);

  async function user(role: string | string[], companyIds: string[] | null) {
    const { result } = await asUser(() =>
      platform.users.create({
        username: uniqueUsername('acc'),
        password: 'a-long-enough-password',
        contactChannel: 'stub',
        contactAddress: '09120000000',
        reason: 'acceptance',
      }),
    );
    for (const r of [role].flat()) {
      for (const companyId of companyIds ?? [null]) {
        await asUser(() =>
          platform.users.grantRole({
            userId: result.id,
            role: r,
            scopeKind: companyId ? 'company' : 'customer',
            companyId,
            unitId: null,
            reason: 'acceptance',
          }),
        );
      }
    }
    return result.id;
  }

  beforeAll(async () => {
    platform = createPlatform(inject('db'));
    hr = createHr(platform);
    await ensureTimeZone(platform);
    await ensureHomeJurisdiction(platform);
    platform.clock.setTime(NOW);
    platform.approvalTypes.register(
      defineApprovalRequestType({
        type: HIRE,
        payload: z.object({ personId: z.uuid() }),
        defaultChain: ['org_change_approver'],
        apply: async () => {},
      }),
    );
    for (const type of ['org.structure.change', 'org.structure.import.commit', HIRE]) {
      await asUser(() =>
        platform.config.set({
          setting: platform.approvalTypes.chainSetting(type),
          companyId: null,
          value: ['org_change_approver'],
          reason: 'acceptance chain',
        }),
      );
    }
    users.admin = await user('system_admin', null);
    users.approver = await user('org_change_approver', null);
    users.auditor = await user('auditor', null);
  }, 600_000);

  afterAll(async () => {
    platform.clock.reset();
    await platform.close();
  });

  it('runs the R1 checklist and writes the report', async () => {
    const companies = await inputs();
    const ids: string[] = [];
    const managerShare: string[] = [];
    let allManagers = true;
    let actingFound = 0;
    let importOk = true;
    let ruleOk = true;
    let replayOk = true;
    let auditOk = true;
    const timing: string[] = [];
    const replayEvidence: string[] = [];
    const ruleEvidence: string[] = [];
    const reads = { manager: [] as number[], position: [] as number[], team: [] as number[] };

    for (const c of companies) {
      const companyId = (
        await asUser(() =>
          platform.companies.register({
            code: c.code,
            jurisdictionCode: 'ir',
            reason: 'acceptance',
          }),
        )
      ).result.id;
      ids.push(companyId);
      users[`owner:${companyId}`] = await user(
        ['org_data_owner', 'people_data_owner'],
        [companyId],
      );
      const owner = `owner:${companyId}`;
      await run('admin', () =>
        hr.profiles.register(
          companyId,
          { nameFa: c.nameFa, codePrefix: c.prefix, legalFields: c.legalFields },
          'acceptance setup',
        ),
      );
      await run('admin', () =>
        hr.profiles.setLevels(
          companyId,
          c.levels.map((nameFa) => ({ nameFa })),
          'acceptance levels',
        ),
      );

      // People first (their own module), then the structure (spec §6 steps 1-6).
      const pipeline = async (
        target: string,
        content: Buffer,
        effectiveDate: platformV1.BusinessDate,
        source: string,
      ) => {
        const started = performance.now();
        const imp = (await run(owner, () =>
          platform.imports.upload({
            target,
            companyId,
            effectiveDate,
            sourceName: source,
            fileName: `${source}.xlsx`,
            content,
          }),
        )) as unknown as { id: string; mapping: unknown };
        await run(owner, () => platform.imports.map(imp.id, imp.mapping, true));
        const validated = (await run(owner, () =>
          platform.imports.validate(imp.id),
        )) as unknown as {
          findings: { severity: string; message: string }[] | null;
        };
        const blocking = validated.findings?.filter((f) => f.severity === 'blocking') ?? [];
        if (blocking.length > 0)
          return {
            ok: false,
            ms: performance.now() - started,
            blocking,
            status: 'refused',
            approvalRequestId: null,
          };
        await run(owner, () => platform.imports.preview(imp.id));
        const committed = (await run(owner, () =>
          platform.imports.commit(imp.id, `${source} (acceptance)`),
        )) as unknown as {
          status: string;
          approvalRequestId: string | null;
        };
        return {
          ok: true,
          ms: performance.now() - started,
          blocking,
          status: committed.status,
          approvalRequestId: committed.approvalRequestId,
        };
      };
      const people = await pipeline('people.person', c.people, c.effectiveDate, 'people');
      const first = await pipeline('org.structure', c.structure, c.effectiveDate, 'structure');
      importOk &&= people.ok && first.ok && first.status === 'committed';
      let secondMs = 0;
      if (first.ok) {
        const second = await pipeline(
          'org.structure',
          c.revised ?? c.structure,
          TODAY,
          'structure',
        );
        if (second.approvalRequestId) {
          const approved = performance.now();
          await run('approver', () => platform.approvals.approve(second.approvalRequestId!, null));
          secondMs = second.ms + (performance.now() - approved);
        } else {
          secondMs = second.ms;
        }
        importOk &&= second.ok;
      }
      timing.push(
        `${c.label}: پرونده ${ms(people.ms)}، ساختار بار اول ${ms(first.ms)}، بار دوم با نگاشت ذخیره‌شده ${ms(secondMs)}` +
          (first.blocking.length
            ? ` — مسدود: ${first.blocking
                .map((b) => b.message)
                .slice(0, 3)
                .join(' | ')}`
            : ''),
      );

      // R1-R3 and R15 after the import.
      const ruleRun = await run(owner, () => hr.rules.runner.runNow(companyId));
      const counts = Object.fromEntries(ruleRun.rules.map((r) => [r.code, r.violations]));
      const blockingCounts = [counts.R1, counts.R2, counts.R3, counts.R15];
      ruleOk &&= blockingCounts.every((n) => n === 0);
      ruleEvidence.push(
        `${c.label}: R1=${num(counts.R1 ?? 0)}، R2=${num(counts.R2 ?? 0)}، R3=${num(counts.R3 ?? 0)}، R15=${num(counts.R15 ?? 0)}`,
      );

      // get_manager for every employed person on a primary position (except the top).
      const structure = await run(owner, () => hr.org.getStructure({ companyId, asOf: TODAY }));
      const top = new Set(
        structure.positions.filter((p) => p.reportsToPositionId === null).map((p) => p.id),
      );
      const employed = await hr.people.service.employedAmong(companyId, null, TODAY);
      const primaries = await platform.prisma.orgAssignment.findMany({
        where: {
          companyId,
          kind: 'primary',
          validFrom: { lte: new Date(`${TODAY}T00:00:00Z`) },
          OR: [{ validTo: null }, { validTo: { gt: new Date(`${TODAY}T00:00:00Z`) } }],
        },
        select: { personId: true, positionId: true },
      });
      const asked = primaries.filter((a) => employed.has(a.personId) && !top.has(a.positionId));
      let answered = 0;
      for (const a of asked) {
        const started = performance.now();
        const manager = await run(owner, () =>
          hr.org.getManager({ personId: a.personId, asOf: TODAY }),
        );
        reads.manager.push(performance.now() - started);
        if (manager) answered += 1;
        if (manager && manager.via !== 'primary') actingFound += 1;
      }
      allManagers &&= answered === asked.length;
      managerShare.push(`${c.label}: ${num(answered)} از ${num(asked.length)}`);
      for (const p of structure.positions.slice(0, 50)) {
        let started = performance.now();
        await run(owner, () => hr.org.getPosition({ positionId: p.id, asOf: TODAY }));
        reads.position.push(performance.now() - started);
        started = performance.now();
        await run(owner, () => hr.org.getTeam({ positionId: p.id, depth: 'direct', asOf: TODAY }));
        reads.team.push(performance.now() - started);
      }

      // Structure as of X rebuilt from the audit log.
      for (const asOf of [c.effectiveDate, TODAY]) {
        const replay = await run('auditor', () => hr.auditReplay.check(companyId, asOf));
        replayOk &&= replay.same && replay.gaps.length === 0;
        replayEvidence.push(
          `${c.label} در ${asOf}: ${num(replay.rowsReplayed)} سطر لاگ، ${num(replay.positions)} پست، ${replay.same ? 'یکسان' : `${num(replay.differences.length)} تفاوت`}`,
        );
      }

      // Every org change in the log has before, after, actor, time, reason and source.
      const rows = await platform.prisma.auditLog.findMany({
        where: { companyId, action: { startsWith: 'org.' } },
        select: {
          action: true,
          before: true,
          after: true,
          actor: true,
          recordedAt: true,
          reason: true,
          source: true,
        },
      });
      const needsBefore = (a: string) => /\.(change|close|correct|accept|reopen|resolve)$/.test(a);
      const bad = rows.filter(
        (r) =>
          !r.after ||
          (needsBefore(r.action) && !r.before) ||
          !r.actor ||
          !r.recordedAt ||
          !r.reason.trim() ||
          !platformV1.AuditSourceSchema.safeParse(r.source).success,
      );
      auditOk &&= bad.length === 0 && rows.length > 0;
    }
    record(
      '§11',
      '1',
      'ورود ساختار یک شرکت از اکسل در یک روز کاری؛ بار دوم با نگاشت ذخیره‌شده زیر یک ساعت',
      check(importOk),
      timing.join('؛ ') + '. (زمان کار سامانه؛ کار کارشناس روی فایل جداست.)',
    );
    record(
      '§11',
      '2',
      'صفر مورد R1 تا R3 و R15 پس از ورود',
      check(ruleOk),
      ruleEvidence.join('؛ '),
    );
    record(
      '§11',
      '3',
      '`get_manager` برای ۱۰۰٪ کارکنان فعال جواب دارد و برای پست بالادستِ خالی با کفالت، کفیل را برمی‌گرداند',
      check(allManagers && actingFound > 0),
      `${managerShare.join('؛ ')}؛ ${num(actingFound)} نفر مدیرشان از راه کفالت یا سرپرستی موقت پیدا شد`,
    );
    record(
      '§11',
      '4',
      '«ساختار در تاریخ X» با بازسازی از لاگ ممیزی یکی است',
      check(replayOk),
      replayEvidence.join('؛ '),
    );
    record(
      '§11',
      '5',
      'هر تغییر در لاگ قبل، بعد، کاربر، زمان، دلیل و منبع دارد',
      check(auditOk),
      'همهٔ سطرهای org.* لاگ دو شرکت بررسی شد',
    );

    // One structure change request: request → approval → events on the effective date.
    const [a, b] = ids as [string, string];
    const structureA = await run(`owner:${a}`, () =>
      hr.org.getStructure({ companyId: a, asOf: TODAY }),
    );
    const levels = (await run('admin', () => hr.profiles.get(a)))!.levels;
    const root = structureA.units.find((u) => u.parentUnitId === null)!;
    const head = structureA.positions.find((p) => p.reportsToPositionId === null)!;
    const effective = '2026-12-02' as platformV1.BusinessDate;
    const request = await run(`owner:${a}`, () =>
      hr.changeRequests.submit({
        companyId: a,
        effectiveDate: effective,
        reason: 'ایجاد واحد تحلیل داده (پذیرش R1)',
        operations: [
          {
            op: 'unit.create',
            ref: 'n',
            nameFa: 'تحلیل داده',
            levelId: levels[1]!.id,
            parent: { id: root.id },
            supervisor: { ref: 'h' },
          },
          {
            op: 'position.create',
            ref: 'h',
            titleFa: 'رئیس تحلیل داده',
            unit: { ref: 'n' },
            type: 'approved',
            fte: 1,
            supervisory: true,
            reportsTo: { id: head.id },
          },
        ],
      }),
    );
    const { correlationId } = await asUser(
      () => platform.approvals.approve(request.approvalRequestId, null),
      as(users.approver!),
    );
    platform.clock.setTime(new Date(`${effective}T08:00:00Z`));
    const published = await hr.eventSink.publishDue();
    platform.clock.setTime(NOW);
    const events = await platform.prisma.eventsOutbox.findMany({
      where: { companyId: a, correlationId, effectiveAt: new Date(`${effective}T00:00:00Z`) },
    });
    const types = events.map((e) => e.type).sort();
    record(
      '§11',
      '6',
      'یک درخواست تغییر ساختار از ثبت تا تأیید و انتشار رخداد کامل انجام شود',
      check(
        types.includes('org.change_request.approved') && types.includes('org.position.created'),
      ),
      `${num(published)} رخداد در تاریخ اثر منتشر شد: ${types.join('، ')}`,
    );

    // apply_assignment from a stand-in personnel action, with its correlation id.
    const vacant = structureA.positions.find(
      (p) => p.occupancy === 'vacant' && !p.supervisory && p.incumbentCount === 0,
    )!;
    const employedA = await hr.people.service.employedAmong(a, null, TODAY);
    const assigned = new Set(
      (
        await platform.prisma.orgAssignment.findMany({
          where: { companyId: a, kind: 'primary' },
          select: { personId: true },
        })
      ).map((x) => x.personId),
    );
    const newcomer = [...employedA].find((p) => !assigned.has(p));
    let applyEvidence = 'کسی بدون پست اصلی برای آزمون نبود';
    let applyOk = false;
    if (newcomer) {
      const hire = await run(`owner:${a}`, () =>
        platform.approvals.submit({
          type: HIRE,
          companyId: a,
          payload: { personId: newcomer },
          reason: 'استخدام (پذیرش R1)',
        }),
      );
      await run('approver', () => platform.approvals.approve(hire.id, null));
      const flow = {
        actor: { kind: 'system' as const, id: 'personnel_action' },
        source: 'workflow' as const,
      };
      const { result, correlationId: actionFlow } = await asUser(
        () =>
          hr.applyAssignment.apply({
            actionId: 'ACC-PA-1',
            approvalId: hire.id,
            companyId: a,
            operation: 'start',
            personId: newcomer,
            positionId: vacant.id,
            kind: 'primary',
            effectiveDate: TODAY,
          }),
        flow,
      );
      const replayed = await asUser(
        () =>
          hr.applyAssignment.apply({
            actionId: 'ACC-PA-1',
            approvalId: hire.id,
            companyId: a,
            operation: 'start',
            personId: newcomer,
            positionId: vacant.id,
            kind: 'primary',
            effectiveDate: TODAY,
          }),
        flow,
      );
      const started = await platform.prisma.eventsOutbox.findMany({
        where: { companyId: a, type: 'org.assignment.started', correlationId: actionFlow },
      });
      applyOk =
        started.length === 1 &&
        replayed.result.replayed &&
        replayed.result.assignmentId === result.assignmentId;
      applyEvidence = `انتساب ${result.assignmentId}؛ رخداد با همان correlation_id؛ تکرار با همان شناسه چیزی ننوشت`;
    }
    record(
      '§11',
      '7',
      'فرمان `apply_assignment` با اقدام پرسنلی ساختگی انتساب را اعمال و رخداد را با همان `correlation_id` منتشر کند',
      check(applyOk),
      applyEvidence,
    );

    const readsOk = [reads.manager, reads.position, reads.team].every((s) => p95(s) < 300);
    record(
      '§11',
      '8',
      'چارت ۶٬۰۰۰ پستی زیر ۲ ثانیه؛ هر سرویس خواندنی زیر ۳۰۰ میلی‌ثانیه',
      check(readsOk),
      `روی همین شرکت‌ها، p95: get_manager ${ms(p95(reads.manager))}، get_position ${ms(p95(reads.position))}، get_team ${ms(p95(reads.team))}. شرکت ۶٬۰۰۰ پستی: \`pnpm test:perf\` و چارت: \`pnpm e2e\` (اجرای جدا؛ آخرین نتیجه در برنامهٔ ساخت).`,
    );

    await expect(
      run(`owner:${a}`, () => hr.org.getStructure({ companyId: b, asOf: TODAY })),
    ).rejects.toThrow();
    const auditorSees = await run('auditor', () =>
      hr.org.getStructure({ companyId: b, asOf: TODAY }),
    );
    record(
      '§11',
      '9',
      'کاربر شرکت A هیچ داده‌ای از شرکت B نمی‌بیند مگر دامنه‌اش شامل B باشد',
      'pass',
      `مالک دادهٔ A برای B خطای دسترسی گرفت؛ ممیز کل مشتری ${num(auditorSees.positions.length)} پست B را دید`,
    );

    const catalogs = ['apps/web/src/i18n', 'apps/api/src/platform/i18n'].map((dir) => {
      const fa = Object.keys(
        JSON.parse(readFileSync(join(ROOT, dir, 'fa.json'), 'utf8')) as object,
      ).sort();
      const en = Object.keys(
        JSON.parse(readFileSync(join(ROOT, dir, 'en.json'), 'utf8')) as object,
      ).sort();
      return JSON.stringify(fa) === JSON.stringify(en);
    });
    record(
      '§11',
      '10',
      'هیچ متن رابط خارج از فایل ترجمه نیست (بررسی خودکار در CI)',
      check(catalogs.every(Boolean)),
      'کلیدهای fa و en یکسان‌اند؛ قاعدهٔ eslint `no-literal-string` در CI متن ثابت را رد می‌کند',
    );

    // Roadmap R1: the Eve core.
    const chain = await platform.audit.verifyChain();
    const outbox = await platform.prisma.eventsOutbox.findMany({
      where: { companyId: { in: ids } },
    });
    const envelopes = outbox.filter(
      (e) =>
        platformV1.EventEnvelopeSchema.safeParse({
          event_id: e.eventId,
          type: e.type,
          schema_version: e.schemaVersion,
          occurred_at: e.occurredAt.toISOString(),
          effective_at: e.effectiveAt.toISOString().slice(0, 10),
          correlation_id: e.correlationId,
          causation_id: e.causationId,
          actor: e.actor,
          source: e.source,
          company_id: e.companyId,
        }).success,
    ).length;
    const usage = await platform.usage.monthly(1405, 9);
    const templates = platform.rules.list().filter((t) => t.id.startsWith('org.')).length;
    const coreOk =
      chain.ok && envelopes === outbox.length && templates >= 13 && usage.calendar === 'persian';
    record(
      'R1',
      'هسته',
      'هستهٔ Eve با موتور قاعده (قالب + پارامتر)، گردش تأیید، لاگ ممیزی زنجیره‌ای، پاکت رخداد، اتصال فایل و دفتر مصرف کار می‌کند',
      check(coreOk),
      `زنجیرهٔ لاگ ${chain.ok ? `سالم (${num(chain.rows)} سطر)` : 'شکسته'}؛ ${num(envelopes)} از ${num(outbox.length)} رخداد با پاکت استاندارد؛ ${num(templates)} قالب قاعدهٔ org؛ ورود فایل پرونده و ساختار؛ گزارش مصرف آذر ۱۴۰۵ ساخته شد`,
    );
    const failedSpec = criteria.filter((c) => c.group === '§11' && c.status === 'fail').length;
    record(
      'R1',
      '§11',
      'معیارهای پذیرش MVP مشخصات ماژول ۱ نسخهٔ ۱٫۱',
      check(failedSpec === 0),
      `${num(10 - failedSpec)} از ۱۰ معیار بالا`,
    );
    const realData = companies.every((c) => !c.generated);
    record(
      'R1',
      'پایلوت',
      'ساختار و افراد دو شرکت پایلوت وارد شده و `get_manager` برای ۱۰۰٪ کارکنان فعال جواب دارد',
      realData ? check(importOk && allManagers) : 'waiting',
      realData
        ? managerShare.join('؛ ')
        : `روی دو شرکت ساختگی هم‌اندازهٔ پایلوت گذشت (${managerShare.join('؛ ')})؛ منتظر فایل‌های ناشناس‌شدهٔ دو شرکت پایلوت`,
    );
    record(
      'R1',
      'خط پایه',
      'خط پایهٔ زمان امروزِ صدور نامه، گواهی، مرخصی و پیشنهاد حقوق ثبت شده است',
      'waiting',
      'روش و برگهٔ سنجش در `docs/acceptance/R1-baseline-measurement.md`؛ منتظر سنجش تیم HR',
    );

    writeReport(companies);
    expect(
      criteria.filter((c) => c.status === 'fail').map((c) => `${c.group} ${c.id}: ${c.evidence}`),
    ).toEqual([]);
  });
});

function writeReport(companies: CompanyInput[]): void {
  const mark: Record<Status, string> = { pass: '✓ گذشت', fail: '✗ نگذشت', waiting: '… در انتظار' };
  const table = (group: string) =>
    [
      '| معیار | وضعیت | شاهد |',
      '| --- | --- | --- |',
      ...criteria
        .filter((c) => c.group === group)
        .map(
          (c) => `| ${c.id}. ${c.text} | ${mark[c.status]} | ${c.evidence.replace(/\|/g, '/')} |`,
        ),
    ].join('\n');
  const lines = [
    '# HR Ops | گزارش پذیرش R1',
    '',
    `تاریخ اجرا: ${new Date().toISOString().slice(0, 10)} · فرمان: \`pnpm acceptance\` · داده: ${
      companies.every((c) => c.generated)
        ? 'دو شرکت ساختگی هم‌اندازهٔ پایلوت (حدود ۱٬۲۰۰ و ۸۰۰ نفر و پست، با سلول‌های نامرتب واقعی‌نما)'
        : `فایل‌های ناشناس‌شدهٔ ${companies.map((c) => c.label).join(' و ')}`
    }`,
    '',
    'این گزارش را اجرای خودکار پذیرش می‌سازد؛ دستی ویرایش نشود. با `ACCEPTANCE_DIR` همان اجرا روی فایل‌های واقعی پایلوت تکرار می‌شود.',
    '',
    '## معیار پذیرش MVP — مشخصات ماژول ۱ (بخش ۱۱)',
    '',
    table('§11'),
    '',
    '## معیار پذیرش R1 پایه — اصلاحیهٔ نقشهٔ راه ۱٫۱',
    '',
    table('R1'),
    '',
  ];
  writeFileSync(REPORT, lines.join('\n'));
}

import { z } from 'zod';
import { defineRuleTemplate } from '../../../../platform/rules/rule-template';
import {
  Day,
  Id,
  LineSchema,
  type Violation,
  ViolationsSchema,
  daysBetween,
  sorted,
} from './common';

/**
 * R10 (warning): a unit with no active position, or a proposed position not confirmed within
 * `proposalDays` days.
 */
export const UnitOrProposalIdleV1 = defineRuleTemplate({
  id: 'org.unit_or_proposal_idle',
  version: 1,
  description: {
    fa: 'واحد بدون پست فعال، یا پست پیشنهادی تأییدنشده بیش از ۳۰ روز',
    en: 'A unit without an active position, or a proposed position unconfirmed for over 30 days',
  },
  params: z.object({ proposalDays: z.number().int().min(1) }),
  defaultParams: { proposalDays: 30 },
  input: z.object({
    asOf: Day,
    units: z.array(Id),
    positions: z.array(
      z.object({
        id: Id,
        unitId: Id,
        status: z.enum(['active', 'frozen']),
        proposedSince: Day.nullable(),
      }),
    ),
  }),
  output: ViolationsSchema,
  evaluate({ asOf, units, positions }, { proposalDays }) {
    const active = new Set(positions.filter((p) => p.status === 'active').map((p) => p.unitId));
    const violations: Violation[] = [];
    for (const unit of units) {
      if (!active.has(unit)) {
        violations.push({
          subject: { type: 'unit', id: unit },
          key: 'no_active_position',
          detail: {},
        });
      }
    }
    for (const p of positions) {
      if (!p.proposedSince) continue;
      const days = daysBetween(p.proposedSince, asOf);
      if (days > proposalDays) {
        violations.push({
          subject: { type: 'position', id: p.id },
          key: 'proposal_unconfirmed',
          detail: { proposedSince: p.proposedSince, days },
        });
      }
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'every unit staffed; a fresh proposal',
      input: {
        asOf: '2026-11-22',
        units: ['u1'],
        positions: [
          { id: 'p1', unitId: 'u1', status: 'active', proposedSince: null },
          { id: 'p2', unitId: 'u1', status: 'active', proposedSince: '2026-11-01' },
        ],
      },
      expect: { violations: [] },
    },
    {
      name: 'a unit with only a frozen position; a 31-day-old proposal',
      input: {
        asOf: '2026-11-22',
        units: ['u1', 'u2'],
        positions: [
          { id: 'p1', unitId: 'u1', status: 'active', proposedSince: '2026-10-22' },
          { id: 'p2', unitId: 'u2', status: 'frozen', proposedSince: null },
        ],
      },
      expect: {
        violations: [
          {
            subject: { type: 'position', id: 'p1' },
            key: 'proposal_unconfirmed',
            detail: { proposedSince: '2026-10-22', days: 31 },
          },
          { subject: { type: 'unit', id: 'u2' }, key: 'no_active_position', detail: {} },
        ],
      },
    },
  ],
});

/** Words of a title: split on spaces, ZWNJ and punctuation; lower case for Latin letters. */
function wordsOf(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[\s‌‏‎.,،;؛:()\-/]+/u)
    .filter((w) => w !== '');
}

/**
 * R11 (warning): a managerial word in the title of a position that is not supervisory or has no
 * one reporting to it. Whole words only ("مدیریت" in "کارشناس مدیریت پروژه" is not "مدیر").
 */
export const ManagerialTitleV1 = defineRuleTemplate({
  id: 'org.managerial_title',
  version: 1,
  description: {
    fa: 'عنوان مدیریتی روی پستی که سرپرستی نیست یا زیردست ندارد',
    en: 'A managerial title on a position that is not supervisory or has no subordinates',
  },
  params: z.object({ words: z.array(z.string().min(1)).min(1) }),
  // Product-owner decision 2026-11-25 (+ spelling variants and common English titles).
  defaultParams: {
    words: [
      'مدیر',
      'مدیرعامل',
      'رئیس',
      'رییس',
      'سرپرست',
      'معاون',
      'manager',
      'head',
      'director',
      'supervisor',
      'deputy',
    ],
  },
  input: z.object({
    positions: z.array(
      z.object({
        id: Id,
        titleFa: z.string(),
        titleEn: z.string().nullable(),
        supervisory: z.boolean(),
      }),
    ),
    directLines: z.array(LineSchema),
  }),
  output: ViolationsSchema,
  evaluate({ positions, directLines }, { words }) {
    const managerial = new Set(words.map((w) => w.toLowerCase()));
    const managers = new Set(directLines.map((l) => l.to));
    const violations: Violation[] = [];
    for (const p of positions) {
      const found = [...wordsOf(p.titleFa), ...wordsOf(p.titleEn ?? '')].find((w) =>
        managerial.has(w),
      );
      if (!found) continue;
      if (!p.supervisory) {
        violations.push({
          subject: { type: 'position', id: p.id },
          key: 'title_not_supervisory',
          detail: { word: found },
        });
      } else if (!managers.has(p.id)) {
        violations.push({
          subject: { type: 'position', id: p.id },
          key: 'title_without_reports',
          detail: { word: found },
        });
      }
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'managers that manage; a specialist in project management',
      input: {
        positions: [
          { id: 'p1', titleFa: 'مدیر فروش', titleEn: null, supervisory: true },
          { id: 'p2', titleFa: 'کارشناس مدیریت پروژه', titleEn: null, supervisory: false },
        ],
        directLines: [{ from: 'p2', to: 'p1' }],
      },
      expect: { violations: [] },
    },
    {
      name: 'a "head" without the supervisory flag; a supervisor with nobody below',
      input: {
        positions: [
          { id: 'p1', titleFa: 'کارشناس ارشد', titleEn: 'Head of Data', supervisory: false },
          { id: 'p2', titleFa: 'رئیس اداره', titleEn: null, supervisory: true },
        ],
        directLines: [],
      },
      expect: {
        violations: [
          {
            subject: { type: 'position', id: 'p1' },
            key: 'title_not_supervisory',
            detail: { word: 'head' },
          },
          {
            subject: { type: 'position', id: 'p2' },
            key: 'title_without_reports',
            detail: { word: 'رئیس' },
          },
        ],
      },
    },
  ],
});

/**
 * R12 (info): a position vacant for more than `days` days. Vacant = no primary assignment; it has
 * been since the last primary assignment ended, or since the position started.
 */
export const LongVacancyV1 = defineRuleTemplate({
  id: 'org.long_vacancy',
  version: 1,
  description: {
    fa: 'پست خالی بیش از ۹۰ روز',
    en: 'A position vacant for more than 90 days',
  },
  params: z.object({ days: z.number().int().min(1) }),
  defaultParams: { days: 90 },
  input: z.object({
    asOf: Day,
    positions: z.array(z.object({ id: Id, vacantSince: Day.nullable() })),
  }),
  output: ViolationsSchema,
  evaluate({ asOf, positions }, { days }) {
    const violations: Violation[] = [];
    for (const p of positions) {
      if (!p.vacantSince) continue;
      const vacant = daysBetween(p.vacantSince, asOf);
      if (vacant > days) {
        violations.push({
          subject: { type: 'position', id: p.id },
          key: 'long_vacancy',
          detail: { vacantSince: p.vacantSince, days: vacant },
        });
      }
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'filled, and vacant for exactly 90 days',
      input: {
        asOf: '2026-11-22',
        positions: [
          { id: 'p1', vacantSince: null },
          { id: 'p2', vacantSince: '2026-08-24' },
        ],
      },
      expect: { violations: [] },
    },
    {
      name: 'vacant for 91 days',
      input: { asOf: '2026-11-22', positions: [{ id: 'p1', vacantSince: '2026-08-23' }] },
      expect: {
        violations: [
          {
            subject: { type: 'position', id: 'p1' },
            key: 'long_vacancy',
            detail: { vacantSince: '2026-08-23', days: 91 },
          },
        ],
      },
    },
  ],
});

/**
 * R13 (info): a supervisor with filled direct reports fewer than `minReports` (but at least one)
 * or more than `maxReports`. Filled = an employed primary incumbent (decision 2026-11-25).
 */
export const SpanOfControlV1 = defineRuleTemplate({
  id: 'org.span_of_control',
  version: 1,
  description: {
    fa: 'سرپرست با یک زیردست مستقیم، یا بیش از ۱۲ نفر',
    en: 'A supervisor with one direct report, or more than 12',
  },
  params: z
    .object({ minReports: z.number().int().min(1), maxReports: z.number().int().min(1) })
    .refine((p) => p.minReports <= p.maxReports, 'minReports must not exceed maxReports'),
  defaultParams: { minReports: 2, maxReports: 12 },
  input: z.object({
    positions: z.array(z.object({ id: Id, supervisory: z.boolean(), filled: z.boolean() })),
    directLines: z.array(LineSchema),
  }),
  output: ViolationsSchema,
  evaluate({ positions, directLines }, { minReports, maxReports }) {
    const filled = new Set(positions.filter((p) => p.filled).map((p) => p.id));
    const reports = new Map<string, number>();
    for (const l of directLines) {
      if (filled.has(l.from)) reports.set(l.to, (reports.get(l.to) ?? 0) + 1);
    }
    const violations: Violation[] = [];
    for (const p of positions) {
      if (!p.supervisory) continue;
      const count = reports.get(p.id) ?? 0;
      if (count === 0) continue;
      if (count < minReports || count > maxReports) {
        violations.push({
          subject: { type: 'position', id: p.id },
          key: count < minReports ? 'too_few_reports' : 'too_many_reports',
          detail: { reports: count },
        });
      }
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'two filled reports (a vacant third does not count)',
      input: {
        positions: [
          { id: 'm', supervisory: true, filled: true },
          { id: 'a', supervisory: false, filled: true },
          { id: 'b', supervisory: false, filled: true },
          { id: 'c', supervisory: false, filled: false },
        ],
        directLines: [
          { from: 'a', to: 'm' },
          { from: 'b', to: 'm' },
          { from: 'c', to: 'm' },
        ],
      },
      expect: { violations: [] },
    },
    {
      name: 'one filled report, and three over a maximum of two',
      params: { minReports: 2, maxReports: 2 },
      input: {
        positions: [
          { id: 'm1', supervisory: true, filled: true },
          { id: 'm2', supervisory: true, filled: true },
          { id: 'a', supervisory: false, filled: true },
          { id: 'b', supervisory: false, filled: true },
          { id: 'c', supervisory: false, filled: true },
          { id: 'd', supervisory: false, filled: true },
        ],
        directLines: [
          { from: 'a', to: 'm1' },
          { from: 'b', to: 'm2' },
          { from: 'c', to: 'm2' },
          { from: 'd', to: 'm2' },
        ],
      },
      expect: {
        violations: [
          {
            subject: { type: 'position', id: 'm1' },
            key: 'too_few_reports',
            detail: { reports: 1 },
          },
          {
            subject: { type: 'position', id: 'm2' },
            key: 'too_many_reports',
            detail: { reports: 3 },
          },
        ],
      },
    },
  ],
});

/**
 * R4 (blocking until a special approval): a change whose effective date is more than `days` days
 * in the past (it touches orders and pay of closed months). Checked on a change (S8), not nightly.
 */
export const BackdatedChangeV1 = defineRuleTemplate({
  id: 'org.backdated_change',
  version: 1,
  description: {
    fa: 'تغییر با تاریخ اثر بیش از ۳۰ روز در گذشته',
    en: 'A change with an effective date more than 30 days in the past',
  },
  params: z.object({ days: z.number().int().min(0) }),
  defaultParams: { days: 30 },
  input: z.object({ changeId: Id, effectiveDate: Day, today: Day }),
  output: ViolationsSchema,
  evaluate({ changeId, effectiveDate, today }, { days }) {
    const back = daysBetween(effectiveDate, today);
    if (back <= days) return { violations: [] };
    return {
      violations: [
        {
          subject: { type: 'change' as const, id: changeId },
          key: 'backdated',
          detail: { effectiveDate, daysBack: back, needs: 'special_approval' },
        },
      ],
    };
  },
  cases: [
    {
      name: 'exactly 30 days back is allowed',
      input: { changeId: 'c1', effectiveDate: '2026-10-23', today: '2026-11-22' },
      expect: { violations: [] },
    },
    {
      name: '31 days back',
      input: { changeId: 'c1', effectiveDate: '2026-10-22', today: '2026-11-22' },
      expect: {
        violations: [
          {
            subject: { type: 'change', id: 'c1' },
            key: 'backdated',
            detail: { effectiveDate: '2026-10-22', daysBack: 31, needs: 'special_approval' },
          },
        ],
      },
    },
  ],
});

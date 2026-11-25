import { z } from 'zod';
import { defineRuleTemplate } from '../../../../platform/rules/rule-template';
import { Id, NoParams, type Violation, ViolationsSchema, sorted } from './common';

const Kind = z.enum(['primary', 'acting', 'temporary_supervision', 'project']);

/**
 * R3 (blocking): one primary assignment per person at a time, and the time shares of primary and
 * project assignments together at most `maxShare`. Acting and temporary supervision come on top
 * of a job and are not counted (product-owner decision 2026-11-25).
 */
export const PersonTimeShareV1 = defineRuleTemplate({
  id: 'org.person_time_share',
  version: 1,
  description: {
    fa: 'یک فرد بیش از یک انتساب اصلی هم‌زمان ندارد و جمع سهم زمانش از ۱ بیشتر نیست',
    en: 'A person has at most one primary assignment at a time and a total time share of at most 1',
  },
  params: z.object({ maxShare: z.number().positive() }),
  defaultParams: { maxShare: 1 },
  input: z.object({
    assignments: z.array(
      z.object({ personId: Id, positionId: Id, kind: Kind, timeShare: z.number().positive() }),
    ),
  }),
  output: ViolationsSchema,
  evaluate({ assignments }, { maxShare }) {
    const byPerson = new Map<string, typeof assignments>();
    for (const a of assignments) byPerson.set(a.personId, [...(byPerson.get(a.personId) ?? []), a]);
    const violations: Violation[] = [];
    for (const [personId, own] of byPerson) {
      const primaries = own.filter((a) => a.kind === 'primary');
      if (primaries.length > 1) {
        violations.push({
          subject: { type: 'person', id: personId },
          key: 'two_primary',
          detail: { positionIds: primaries.map((a) => a.positionId).sort() },
        });
      }
      // Thousandths, as stored (numeric(4,3)), so 0.6 + 0.4 is exactly 1.
      const counted = own.filter((a) => a.kind === 'primary' || a.kind === 'project');
      const total = counted.reduce((sum, a) => sum + Math.round(a.timeShare * 1000), 0);
      if (total > Math.round(maxShare * 1000)) {
        violations.push({
          subject: { type: 'person', id: personId },
          key: 'over_share',
          detail: { total: total / 1000, maxShare },
        });
      }
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'full-time primary plus acting on the manager position',
      input: {
        assignments: [
          { personId: 'a', positionId: 'p1', kind: 'primary', timeShare: 1 },
          { personId: 'a', positionId: 'p2', kind: 'acting', timeShare: 1 },
          { personId: 'b', positionId: 'p3', kind: 'primary', timeShare: 0.6 },
          { personId: 'b', positionId: 'p4', kind: 'project', timeShare: 0.4 },
        ],
      },
      expect: { violations: [] },
    },
    {
      name: 'primary plus project above 1, and two primaries',
      input: {
        assignments: [
          { personId: 'a', positionId: 'p1', kind: 'primary', timeShare: 1 },
          { personId: 'a', positionId: 'p2', kind: 'project', timeShare: 0.5 },
          { personId: 'b', positionId: 'p3', kind: 'primary', timeShare: 0.5 },
          { personId: 'b', positionId: 'p4', kind: 'primary', timeShare: 0.5 },
        ],
      },
      expect: {
        violations: [
          {
            subject: { type: 'person', id: 'a' },
            key: 'over_share',
            detail: { total: 1.5, maxShare: 1 },
          },
          {
            subject: { type: 'person', id: 'b' },
            key: 'two_primary',
            detail: { positionIds: ['p3', 'p4'] },
          },
        ],
      },
    },
  ],
});

/** R15 (blocking): a supervisory position has at most one primary incumbent at a time. */
export const SingleSupervisorV1 = defineRuleTemplate({
  id: 'org.single_supervisor',
  version: 1,
  description: {
    fa: 'پست سرپرستی بیش از یک متصدی اصلی هم‌زمان ندارد',
    en: 'A supervisory position has at most one primary incumbent at a time',
  },
  params: NoParams,
  defaultParams: {},
  input: z.object({
    positions: z.array(z.object({ id: Id, supervisory: z.boolean() })),
    assignments: z.array(z.object({ personId: Id, positionId: Id, kind: Kind })),
  }),
  output: ViolationsSchema,
  evaluate({ positions, assignments }) {
    const supervisory = new Set(positions.filter((p) => p.supervisory).map((p) => p.id));
    const incumbents = new Map<string, string[]>();
    for (const a of assignments) {
      if (a.kind !== 'primary' || !supervisory.has(a.positionId)) continue;
      incumbents.set(a.positionId, [...(incumbents.get(a.positionId) ?? []), a.personId]);
    }
    const violations: Violation[] = [];
    for (const [positionId, people] of incumbents) {
      if (people.length < 2) continue;
      violations.push({
        subject: { type: 'position', id: positionId },
        key: 'two_primary_incumbents',
        detail: { personIds: [...people].sort() },
      });
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'one primary and one acting on a supervisory position; two on a staff position',
      input: {
        positions: [
          { id: 'p1', supervisory: true },
          { id: 'p2', supervisory: false },
        ],
        assignments: [
          { personId: 'a', positionId: 'p1', kind: 'primary' },
          { personId: 'b', positionId: 'p1', kind: 'acting' },
          { personId: 'c', positionId: 'p2', kind: 'primary' },
          { personId: 'd', positionId: 'p2', kind: 'primary' },
        ],
      },
      expect: { violations: [] },
    },
    {
      name: 'two primaries on a supervisory position',
      input: {
        positions: [{ id: 'p1', supervisory: true }],
        assignments: [
          { personId: 'a', positionId: 'p1', kind: 'primary' },
          { personId: 'b', positionId: 'p1', kind: 'primary' },
        ],
      },
      expect: {
        violations: [
          {
            subject: { type: 'position', id: 'p1' },
            key: 'two_primary_incumbents',
            detail: { personIds: ['a', 'b'] },
          },
        ],
      },
    },
  ],
});

/**
 * R7 (warning): an incumbent is not employed on the date (people register; the payroll half comes
 * with the payroll sync, F10). The suggested action is to end the assignment.
 */
export const IncumbentInactiveV1 = defineRuleTemplate({
  id: 'org.incumbent_inactive',
  version: 1,
  description: {
    fa: 'متصدی پست در پرونده غیرفعال است',
    en: 'An incumbent is not active in the personnel register',
  },
  params: NoParams,
  defaultParams: {},
  input: z.object({
    assignments: z.array(z.object({ personId: Id, positionId: Id, kind: Kind })),
    employed: z.array(Id),
  }),
  output: ViolationsSchema,
  evaluate({ assignments, employed }) {
    const active = new Set(employed);
    const violations: Violation[] = [];
    for (const a of assignments) {
      if (active.has(a.personId)) continue;
      violations.push({
        subject: { type: 'person', id: a.personId },
        key: `inactive_on:${a.positionId}:${a.kind}`,
        detail: { positionId: a.positionId, kind: a.kind, suggestion: 'end_assignment' },
      });
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'every incumbent employed',
      input: {
        assignments: [{ personId: 'a', positionId: 'p1', kind: 'primary' }],
        employed: ['a'],
      },
      expect: { violations: [] },
    },
    {
      name: 'a terminated person still acting on a position',
      input: {
        assignments: [
          { personId: 'a', positionId: 'p1', kind: 'primary' },
          { personId: 'b', positionId: 'p2', kind: 'acting' },
        ],
        employed: ['a'],
      },
      expect: {
        violations: [
          {
            subject: { type: 'person', id: 'b' },
            key: 'inactive_on:p2:acting',
            detail: { positionId: 'p2', kind: 'acting', suggestion: 'end_assignment' },
          },
        ],
      },
    },
  ],
});

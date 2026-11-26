import type { orgV1, platformV1 } from '@eve/contracts';
import type { RuleRuntime } from '../../../../platform/rules/rule-runtime';
import type { Violations } from '../rules/common';
import { ORG_RULES, type OrgSnapshot } from '../rules/index';
import { managerChanges } from '../rules/managers';

/**
 * The impact analysis the approver sees (spec §8): who moves to another unit (each needs an
 * order), whose manager changes, which positions lose their people, and which warnings the change
 * would open or resolve. Grades are unknown until grading (Module 2) exists.
 */
export async function computeImpact(
  runtime: RuleRuntime,
  companyId: string,
  before: OrgSnapshot,
  after: OrgSnapshot,
): Promise<orgV1.Impact> {
  const unitBefore = new Map(before.positions.map((p) => [p.id, p.unitId]));
  const unitAfter = new Map(after.positions.map((p) => [p.id, p.unitId]));
  const movedPeople = before.assignments
    .filter((a) => a.kind === 'primary')
    .flatMap((a) => {
      const from = unitBefore.get(a.positionId);
      const to = unitAfter.get(a.positionId);
      return from && to && from !== to
        ? [{ personId: a.personId, positionId: a.positionId, fromUnitId: from, toUnit: to }]
        : [];
    });
  const filledBefore = new Set(before.assignments.map((a) => a.positionId));
  const stillThere = new Set(after.assignments.map((a) => a.positionId));
  const vacatedPositions = [...filledBefore].filter((p) => !stillThere.has(p)).sort();

  const warnings = async (snapshot: OrgSnapshot) => {
    const found = new Map<string, { code: string; subject: string; key: string }>();
    for (const rule of ORG_RULES.filter((r) => r.nightly && r.severity === 'warning')) {
      const record = await runtime.evaluate(
        { id: rule.template.id, version: rule.template.version },
        rule.input(snapshot),
        { asOf: snapshot.asOf as platformV1.BusinessDate, companyId },
      );
      for (const v of (record.output as Violations).violations) {
        const subject = `${v.subject.type}:${v.subject.id}`;
        found.set(`${rule.code}|${subject}|${v.key}`, { code: rule.code, subject, key: v.key });
      }
    }
    return found;
  };
  const [was, will] = await Promise.all([warnings(before), warnings(after)]);
  return {
    movedPeople,
    managerChanges: managerChanges(before, after),
    ordersNeeded: new Set(movedPeople.map((m) => m.personId)).size,
    vacatedPositions,
    warnings: {
      opened: [...will.entries()].filter(([k]) => !was.has(k)).map(([, v]) => v),
      resolved: [...was.entries()].filter(([k]) => !will.has(k)).map(([, v]) => v),
    },
    gradeChanges: 'unknown_until_grading',
  };
}

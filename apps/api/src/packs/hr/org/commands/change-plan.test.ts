import { describe, expect, it } from 'vitest';
import type { platformV1 } from '@eve/contracts';
import type { Current } from '../import/structure-model';
import type { OrgSnapshot } from '../rules/index';
import { effectiveManagers, managerChanges } from '../rules/managers';
import { planChange } from './change-plan';

const D = '2026-12-01' as platformV1.BusinessDate;

/** u1 ⊃ u2; p1 (head, a) ← p2 (b), p3 (vacant, supervisory) ← p4 (c). */
function snapshot(): OrgSnapshot {
  const position = (id: string, unitId: string, supervisory = false) => ({
    id,
    unitId,
    titleFa: 'کارشناس',
    titleEn: null,
    supervisory,
    status: 'active' as const,
    proposedSince: null,
    vacantSince: null,
    filled: true,
  });
  return {
    companyId: 'c',
    asOf: D,
    units: [
      { id: 'u1', parentId: null, supervisorPositionId: 'p1' },
      { id: 'u2', parentId: 'u1', supervisorPositionId: 'p3' },
    ],
    positions: [
      position('p1', 'u1', true),
      position('p2', 'u1'),
      position('p3', 'u2', true),
      position('p4', 'u2'),
    ],
    directLines: [
      { from: 'p2', to: 'p1' },
      { from: 'p3', to: 'p1' },
      { from: 'p4', to: 'p3' },
    ],
    assignments: [
      { personId: 'a', positionId: 'p1', kind: 'primary', timeShare: 1 },
      { personId: 'b', positionId: 'p2', kind: 'primary', timeShare: 1 },
      { personId: 'c', positionId: 'p4', kind: 'primary', timeShare: 1 },
    ],
    employed: ['a', 'b', 'c'],
  };
}

function current(overrides: Partial<Current> = {}): Current {
  const unit = (id: string, parentUnitId: string | null) => ({
    id,
    code: id,
    versionId: `v-${id}`,
    validFrom: '2020-01-01' as platformV1.BusinessDate,
    legacyCode: null,
    nameFa: id,
    nameEn: null,
    levelId: 'L1',
    parentUnitId,
    costCenter: null,
    location: null,
    supervisorPositionId: null,
  });
  const position = (id: string, unitId: string) => ({
    id,
    code: id,
    versionId: `v-${id}`,
    validFrom: '2020-01-01' as platformV1.BusinessDate,
    legacyCode: null,
    titleFa: 'کارشناس',
    titleEn: null,
    unitId,
    jobId: null,
    type: 'approved',
    fte: 1,
    supervisory: false,
    status: 'active',
    source: 'official',
    line: null,
  });
  return {
    profile: { codePrefix: 'X', nextUnitNo: 3, nextPositionNo: 5 },
    levels: new Map([['سطح', 'L1']]),
    units: [unit('u1', null), unit('u2', 'u1')],
    positions: [
      position('p1', 'u1'),
      position('p2', 'u1'),
      position('p3', 'u2'),
      position('p4', 'u2'),
    ],
    assignments: [
      { id: 'x1', personId: 'a', positionId: 'p1', kind: 'primary', timeShare: 1 },
      { id: 'x2', personId: 'b', positionId: 'p2', kind: 'primary', timeShare: 1 },
      { id: 'x3', personId: 'c', positionId: 'p4', kind: 'primary', timeShare: 1 },
    ],
    laterChanged: new Set(),
    hasStructure: true,
    ...overrides,
  };
}

describe('effective managers in memory (same order as get_manager)', () => {
  it('skips a vacant supervisory position to the next one up; nobody manages themselves', () => {
    expect(Object.fromEntries(effectiveManagers(snapshot()))).toEqual({ a: null, b: 'a', c: 'a' });
  });

  it('prefers an acting incumbent of the position above to going further up', () => {
    const s = snapshot();
    s.assignments.push({ personId: 'b', positionId: 'p3', kind: 'acting', timeShare: 1 });
    expect(effectiveManagers(s).get('c')).toBe('b');
    expect(managerChanges(snapshot(), s)).toEqual([{ personId: 'c', from: 'a', to: 'b' }]);
  });
});

describe('planning a change request on the effective date', () => {
  it('builds the resulting structure: new unit and position by ref, a move, a new line', () => {
    const plan = planChange({
      effectiveDate: D,
      current: current(),
      before: snapshot(),
      operations: [
        {
          op: 'unit.create',
          ref: 'n',
          nameFa: 'تازه',
          levelId: 'L1' as never,
          parent: { id: 'u1' },
        },
        {
          op: 'position.create',
          ref: 'h',
          titleFa: 'رئیس',
          unit: { ref: 'n' },
          type: 'approved',
          fte: 1,
          supervisory: true,
          reportsTo: { id: 'p1' },
        },
        {
          op: 'position.update',
          positionId: 'p4',
          changes: { unit: { ref: 'n' }, reportsTo: { ref: 'h' } },
        },
      ],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.whatIf.units.map((u) => u.id)).toContain('new-unit:n');
    expect(plan.whatIf.positions.find((p) => p.id === 'p4')?.unitId).toBe('new-unit:n');
    expect(plan.whatIf.directLines).toContainEqual({ from: 'p4', to: 'new-position:h' });
  });

  it('refuses unknown levels, dangling references, filled closures and dated conflicts', () => {
    const errors = (operations: Parameters<typeof planChange>[0]['operations'], c = current()) =>
      planChange({ effectiveDate: D, current: c, before: snapshot(), operations }).errors.join(
        ' | ',
      );
    expect(
      errors([
        {
          op: 'unit.create',
          ref: 'n',
          nameFa: 'x',
          levelId: 'nope' as never,
          parent: { id: 'u1' },
        },
      ]),
    ).toMatch(/unknown unit level/);
    expect(errors([{ op: 'position.close', positionId: 'p2' }])).toMatch(/incumbents/);
    expect(errors([{ op: 'unit.close', unitId: 'u2' }])).toMatch(/unit is closed/);
    expect(
      errors([
        { op: 'position.update', positionId: 'p2', changes: { reportsTo: { ref: 'ghost' } } },
      ]),
    ).toMatch(/does not exist/);
    expect(
      errors(
        [{ op: 'position.update', positionId: 'p2', changes: { titleFa: 'x' } }],
        current({ laterChanged: new Set(['p2']) }),
      ),
    ).toMatch(/change after/);
    expect(
      errors([
        { op: 'position.update', positionId: 'p2', changes: { titleFa: 'x' } },
        { op: 'position.update', positionId: 'p2', changes: { titleFa: 'y' } },
      ]),
    ).toMatch(/more than one operation/);
  });
});

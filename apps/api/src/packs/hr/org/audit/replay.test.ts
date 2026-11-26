import { describe, expect, it } from 'vitest';
import { type AuditRow, replay, structureAt } from './replay';

let seq = 0n;
const row = (entityType: string, entityId: string, action: string, state: unknown): AuditRow => ({
  seq: ++seq,
  action,
  entityType,
  entityId,
  after: state === undefined ? { note: 'old row' } : { state },
});
const unit = (name: string, parent: string | null) => ({
  legacyCode: null,
  nameFa: name,
  nameEn: null,
  levelId: 'L1',
  parentUnitId: parent,
  costCenter: null,
  location: null,
  supervisorPositionId: null,
});
const position = (title: string, unitId: string) => ({
  legacyCode: null,
  titleFa: title,
  titleEn: null,
  unitId,
  jobId: null,
  type: 'approved',
  fte: 1,
  supervisory: false,
  status: 'active',
  source: 'official',
});

describe('rebuilding the structure from the audit log', () => {
  const rows: AuditRow[] = [
    row('org_unit', 'u1', 'org.unit.create', {
      validFrom: '2026-01-01',
      version: unit('ستاد', null),
    }),
    row('org_unit', 'u2', 'org.unit.create', {
      validFrom: '2026-01-01',
      version: unit('فروش', 'u1'),
    }),
    row('org_position', 'p1', 'org.position.create', {
      validFrom: '2026-01-01',
      version: position('مدیر', 'u1'),
      reportsToPositionId: null,
    }),
    row('org_position', 'p2', 'org.position.create', {
      validFrom: '2026-01-01',
      version: position('کارشناس', 'u2'),
      reportsToPositionId: 'p1',
    }),
    row('org_assignment', 'a1', 'org.assignment.start', {
      personId: 'x',
      positionId: 'p2',
      kind: 'primary',
      timeShare: 1,
      validFrom: '2026-01-01',
    }),
    // From 1 March p2 moves to the head office; from 1 April only its line changes.
    row('org_position', 'p2', 'org.position.change', {
      validFrom: '2026-03-01',
      version: position('کارشناس', 'u1'),
    }),
    row('org_position', 'p2', 'org.position.change', {
      validFrom: '2026-04-01',
      reportsToPositionId: null,
    }),
    // A typo in the first version of p1 is corrected for its whole period.
    row('org_position', 'p1', 'org.position.correct', {
      versionFrom: '2026-01-01',
      changes: { titleFa: 'مدیرعامل' },
    }),
    row('org_unit', 'u1', 'org.unit.supervisor', {
      versionFrom: '2026-01-01',
      changes: { supervisorPositionId: 'p1' },
    }),
    row('org_assignment', 'a1', 'org.assignment.end', { validTo: '2026-05-01' }),
    row('org_unit', 'u2', 'org.unit.close', { validTo: '2026-06-01' }),
  ];
  const replayed = replay(rows);

  it('gives each date its versions, lines and assignments', () => {
    const jan = structureAt(replayed, '2026-01-15');
    expect(jan.positions.get('p2')).toMatchObject({ unitId: 'u2', reportsToPositionId: 'p1' });
    expect(jan.positions.get('p1')?.titleFa).toBe('مدیرعامل');
    expect(jan.units.get('u1')?.supervisorPositionId).toBe('p1');
    expect(jan.assignments).toEqual([
      { id: 'a1', personId: 'x', positionId: 'p2', kind: 'primary' },
    ]);

    const march = structureAt(replayed, '2026-03-15');
    expect(march.positions.get('p2')).toMatchObject({ unitId: 'u1', reportsToPositionId: 'p1' });
    expect(structureAt(replayed, '2026-04-15').positions.get('p2')?.reportsToPositionId).toBeNull();
    expect(structureAt(replayed, '2026-05-15').assignments).toEqual([]);
    expect(structureAt(replayed, '2026-06-15').units.has('u2')).toBe(false);
    expect(structureAt(replayed, '2025-12-31').units.size).toBe(0);
    expect(replayed.gaps).toEqual([]);
  });

  it('reports rows it cannot replay instead of guessing', () => {
    const withGaps = replay([
      ...rows,
      row('org_position', 'p9', 'org.position.create', undefined),
      row('org_assignment', 'a9', 'org.assignment.end', { validTo: '2026-07-01' }),
    ]);
    expect(withGaps.gaps.map((g) => [g.entityId, g.why])).toEqual([
      ['p9', 'no state'],
      ['a9', 'end of an unknown assignment'],
    ]);
  });
});

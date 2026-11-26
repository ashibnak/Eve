/**
 * What every org audit row records in `after.state` (S10): enough to rebuild the dated structure
 * from the audit log alone (spec §11 "ساختار در تاریخ X با بازسازی از لاگ ممیزی یکی است").
 *
 * - A new version: `{ validFrom, version, reportsToPositionId? }` (create, or change from a date).
 * - A change of the reporting line only: `{ validFrom, reportsToPositionId }`.
 * - An end: `{ validTo }` (a unit or position closed; for a position, its line ends too).
 * - A fix in place of one version: `{ versionFrom, changes }` (corrections, a supervisor set).
 * Assignments: `{ personId, positionId, kind, timeShare, validFrom }` to start, `{ validTo }` to end.
 */
export interface UnitVersionState {
  legacyCode: string | null;
  nameFa: string;
  nameEn: string | null;
  levelId: string | null;
  parentUnitId: string | null;
  costCenter: string | null;
  location: string | null;
  supervisorPositionId: string | null;
}

export interface PositionVersionState {
  legacyCode: string | null;
  titleFa: string;
  titleEn: string | null;
  unitId: string;
  jobId: string | null;
  type: string;
  fte: number;
  supervisory: boolean;
  status: string;
  source: string;
}

export type OrgAuditState =
  | {
      validFrom: string;
      version?: UnitVersionState | PositionVersionState;
      reportsToPositionId?: string | null;
    }
  | { validTo: string }
  | { versionFrom: string; changes: Record<string, unknown> }
  | { personId: string; positionId: string; kind: string; timeShare: number; validFrom: string };

/** The audit actions that carry a state, by entity. */
export const ORG_AUDIT_ACTIONS = {
  unit: [
    'org.unit.create',
    'org.unit.change',
    'org.unit.close',
    'org.unit.correct',
    'org.unit.supervisor',
  ],
  position: [
    'org.position.create',
    'org.position.change',
    'org.position.close',
    'org.position.correct',
  ],
  assignment: ['org.assignment.start', 'org.assignment.end'],
} as const;

export function unitState(row: UnitVersionState): UnitVersionState {
  return {
    legacyCode: row.legacyCode,
    nameFa: row.nameFa,
    nameEn: row.nameEn,
    levelId: row.levelId,
    parentUnitId: row.parentUnitId,
    costCenter: row.costCenter,
    location: row.location,
    supervisorPositionId: row.supervisorPositionId,
  };
}

export function positionState(
  row: Omit<PositionVersionState, 'fte'> & { fte: number | string },
): PositionVersionState {
  return {
    legacyCode: row.legacyCode,
    titleFa: row.titleFa,
    titleEn: row.titleEn,
    unitId: row.unitId,
    jobId: row.jobId,
    type: row.type,
    fte: Number(row.fte),
    supervisory: row.supervisory,
    status: row.status,
    source: row.source,
  };
}

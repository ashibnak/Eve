import type { orgV1, platformV1 } from '@eve/contracts';
import { z } from 'zod';
import type { StagedRow } from '../../../../platform/connectors/import-target';
import type { ScopedPrisma } from '../../../../platform/scope/scoped-prisma';
import { dateOf, dayOf, validOn } from '../model/period';

/** Words as HR offices write them, Persian or English (lower-cased before lookup). */
const word = <T extends string>(words: Record<string, T>, values: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((v) => words[v.toLowerCase()] ?? v)
    .pipe(z.enum(values));

export const PositionTypeWords = word(
  {
    مصوب: 'approved',
    approved: 'approved',
    پروژه‌ای: 'project',
    'پروژه ای': 'project',
    پروژه: 'project',
    project: 'project',
    موقت: 'temporary',
    temporary: 'temporary',
  },
  ['approved', 'project', 'temporary'],
);

export const PositionStatusWords = word(
  { فعال: 'active', active: 'active', منجمد: 'frozen', frozen: 'frozen' },
  ['active', 'frozen'],
);

export const AssignmentKindWords = word(
  {
    اصلی: 'primary',
    primary: 'primary',
    کفالت: 'acting',
    acting: 'acting',
    'سرپرستی موقت': 'temporary_supervision',
    temporary_supervision: 'temporary_supervision',
    پروژه‌ای: 'project',
    'پروژه ای': 'project',
    پروژه: 'project',
    project: 'project',
  },
  ['primary', 'acting', 'temporary_supervision', 'project'],
);

export interface FileUnit {
  code: string;
  nameFa: string;
  nameEn: string | null;
  level: string;
  parentCode: string | null;
  costCenter: string | null;
  location: string | null;
  supervisorCode: string | null;
  rowNumber: number;
}

export interface FilePosition {
  /** The legacy code, or `proposed:<unit code>|<title>` for a proposed position. */
  code: string;
  titleFa: string;
  titleEn: string | null;
  unitCode: string;
  type: orgV1.PositionView['type'];
  fte: number;
  supervisory: boolean;
  reportsToCode: string | null;
  status: 'active' | 'frozen';
  proposed: boolean;
  rowNumber: number;
}

export interface FileAssignment {
  personnelCode: string;
  positionCode: string;
  kind: orgV1.AssignmentKind;
  timeShare: number;
  rowNumber: number;
}

export interface FileModel {
  units: Map<string, FileUnit>;
  positions: Map<string, FilePosition>;
  assignments: FileAssignment[];
}

export const proposedCode = (unitCode: string, title: string) => `proposed:${unitCode}|${title}`;

/** The structure the file describes (proposed positions included, reporting to their unit's head). */
export function readFile(rows: readonly StagedRow[]): FileModel {
  const units = new Map<string, FileUnit>();
  const positions = new Map<string, FilePosition>();
  const assignments: FileAssignment[] = [];
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  for (const row of rows) {
    const v = row.values;
    if (row.entity === 'unit') {
      units.set(v.unitCode as string, {
        code: v.unitCode as string,
        nameFa: v.nameFa as string,
        nameEn: text(v.nameEn),
        level: v.level as string,
        parentCode: text(v.parentCode),
        costCenter: text(v.costCenter),
        location: text(v.location),
        supervisorCode: text(v.supervisorPositionCode),
        rowNumber: row.rowNumber,
      });
    } else if (row.entity === 'position') {
      positions.set(v.positionCode as string, {
        code: v.positionCode as string,
        titleFa: v.titleFa as string,
        titleEn: text(v.titleEn),
        unitCode: v.unitCode as string,
        type: v.type as FilePosition['type'],
        fte: (v.fte as number | undefined) ?? 1,
        supervisory: v.supervisory as boolean,
        reportsToCode: text(v.reportsToCode),
        status: (v.status as FilePosition['status'] | undefined) ?? 'active',
        proposed: false,
        rowNumber: row.rowNumber,
      });
    }
  }
  for (const row of rows) {
    if (row.entity !== 'assignment') continue;
    const v = row.values;
    let positionCode = text(v.positionCode);
    const unitCode = text(v.unitCode);
    const title = text(v.title);
    if (!positionCode && unitCode && title) {
      positionCode = proposedCode(unitCode, title);
      if (!positions.has(positionCode)) {
        positions.set(positionCode, {
          code: positionCode,
          titleFa: title,
          titleEn: null,
          unitCode,
          type: 'approved',
          fte: 1,
          supervisory: false,
          reportsToCode: headOf(units, unitCode),
          status: 'active',
          proposed: true,
          rowNumber: row.rowNumber,
        });
      }
    }
    assignments.push({
      personnelCode: v.personnelCode as string,
      positionCode: positionCode ?? '',
      kind: (v.kind as orgV1.AssignmentKind | undefined) ?? 'primary',
      timeShare: (v.timeShare as number | undefined) ?? 1,
      rowNumber: row.rowNumber,
    });
  }
  return { units, positions, assignments };
}

/** The supervisor position of a unit, or of the nearest unit above that has one. */
function headOf(units: ReadonlyMap<string, FileUnit>, unitCode: string): string | null {
  const seen = new Set<string>();
  for (
    let u = units.get(unitCode);
    u && !seen.has(u.code);
    u = u.parentCode ? units.get(u.parentCode) : undefined
  ) {
    seen.add(u.code);
    if (u.supervisorCode) return u.supervisorCode;
  }
  return null;
}

export interface CurrentUnit {
  id: string;
  code: string;
  versionId: string;
  validFrom: platformV1.BusinessDate;
  legacyCode: string | null;
  nameFa: string;
  nameEn: string | null;
  levelId: string | null;
  parentUnitId: string | null;
  costCenter: string | null;
  location: string | null;
  supervisorPositionId: string | null;
}

export interface CurrentPosition {
  id: string;
  code: string;
  versionId: string;
  validFrom: platformV1.BusinessDate;
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
  line: { id: string; to: string; validFrom: platformV1.BusinessDate } | null;
}

export interface Current {
  profile: { codePrefix: string; nextUnitNo: number; nextPositionNo: number } | null;
  levels: Map<string, string>;
  units: CurrentUnit[];
  positions: CurrentPosition[];
  assignments: {
    id: string;
    personId: string;
    positionId: string;
    kind: orgV1.AssignmentKind;
    timeShare: number;
  }[];
  /** Units, positions and positions' direct lines with a version that starts after the date. */
  laterChanged: Set<string>;
  /** Anything recorded at all (a re-import, not a first load). */
  hasStructure: boolean;
}

/** The company's structure on `asOf` as the import compares it with the file. */
export async function loadCurrent(
  db: ScopedPrisma,
  companyId: string,
  asOf: platformV1.BusinessDate,
): Promise<Current> {
  const day = dateOf(asOf);
  const [profile, levels, units, positions, lines, assignments, later, anyUnit] = await Promise.all(
    [
      db.orgCompany.findUnique({
        where: { companyId },
        select: { codePrefix: true, nextUnitNo: true, nextPositionNo: true },
      }),
      db.orgUnitLevel.findMany({ where: { companyId } }),
      db.orgUnitVersion.findMany({
        where: { companyId, status: { not: 'closed' }, ...validOn(day) },
        include: { unit: { select: { code: true } } },
      }),
      db.orgPositionVersion.findMany({
        where: { companyId, status: { not: 'closed' }, ...validOn(day) },
        include: { position: { select: { code: true } } },
      }),
      db.orgReportingLine.findMany({
        where: { companyId, kind: 'direct', ...validOn(day) },
        select: { id: true, fromPositionId: true, toPositionId: true, validFrom: true },
      }),
      db.orgAssignment.findMany({
        where: { companyId, ...validOn(day) },
        select: { id: true, personId: true, positionId: true, kind: true, timeShare: true },
      }),
      Promise.all([
        db.orgUnitVersion.findMany({
          where: { companyId, validFrom: { gt: day } },
          select: { unitId: true },
        }),
        db.orgPositionVersion.findMany({
          where: { companyId, validFrom: { gt: day } },
          select: { positionId: true },
        }),
        db.orgReportingLine.findMany({
          where: { companyId, kind: 'direct', validFrom: { gt: day } },
          select: { fromPositionId: true },
        }),
      ]),
      db.orgUnitVersion.findFirst({ where: { companyId }, select: { id: true } }),
    ],
  );
  const lineOf = new Map(lines.map((l) => [l.fromPositionId, l]));
  const levelByName = new Map<string, string>();
  for (const l of levels) {
    levelByName.set(l.nameFa, l.id);
    if (l.nameEn) levelByName.set(l.nameEn.toLowerCase(), l.id);
  }
  return {
    profile,
    levels: levelByName,
    units: units.map((u) => ({
      id: u.unitId,
      code: u.unit.code,
      versionId: u.id,
      validFrom: dayOf(u.validFrom),
      legacyCode: u.legacyCode,
      nameFa: u.nameFa,
      nameEn: u.nameEn,
      levelId: u.levelId,
      parentUnitId: u.parentUnitId,
      costCenter: u.costCenter,
      location: u.location,
      supervisorPositionId: u.supervisorPositionId,
    })),
    positions: positions.map((p) => {
      const line = lineOf.get(p.positionId);
      return {
        id: p.positionId,
        code: p.position.code,
        versionId: p.id,
        validFrom: dayOf(p.validFrom),
        legacyCode: p.legacyCode,
        titleFa: p.titleFa,
        titleEn: p.titleEn,
        unitId: p.unitId,
        jobId: p.jobId,
        type: p.type,
        fte: p.fte.toNumber(),
        supervisory: p.supervisory,
        status: p.status,
        source: p.source,
        line: line
          ? { id: line.id, to: line.toPositionId, validFrom: dayOf(line.validFrom) }
          : null,
      };
    }),
    assignments: assignments.map((a) => ({
      id: a.id,
      personId: a.personId,
      positionId: a.positionId,
      kind: a.kind as orgV1.AssignmentKind,
      timeShare: a.timeShare.toNumber(),
    })),
    laterChanged: new Set([
      ...later[0].map((u) => u.unitId),
      ...later[1].map((p) => p.positionId),
      ...later[2].map((l) => l.fromPositionId),
    ]),
    hasStructure: anyUnit !== null,
  };
}

import type { orgV1, platformV1 } from '@eve/contracts';
import type { ScopedPrisma } from '../../../../platform/scope/scoped-prisma';
import { dateOf, dayOf, validOn } from '../model/period';
import type { PeopleDirectoryPort } from '../ports/people-directory.port';
import type { OrgSnapshot } from './index';

/**
 * Builds the rules' view of one company on one date from the dated rows (closed units and
 * positions left out). The caller has checked access; `db` reads without scope filtering.
 */
export async function buildSnapshot(
  db: ScopedPrisma,
  people: PeopleDirectoryPort,
  companyId: string,
  asOf: platformV1.BusinessDate,
): Promise<OrgSnapshot> {
  const day = dateOf(asOf);
  const [units, positions, starts, lines, assignments, ended, employed] = await Promise.all([
    db.orgUnitVersion.findMany({
      where: { companyId, status: { not: 'closed' }, ...validOn(day) },
      select: { unitId: true, parentUnitId: true, supervisorPositionId: true },
      orderBy: { unitId: 'asc' },
    }),
    db.orgPositionVersion.findMany({
      where: { companyId, status: { not: 'closed' }, ...validOn(day) },
      select: {
        positionId: true,
        unitId: true,
        titleFa: true,
        titleEn: true,
        supervisory: true,
        status: true,
        source: true,
      },
      orderBy: { positionId: 'asc' },
    }),
    // Every version up to the date: when each position started, and since when it is proposed.
    db.orgPositionVersion.findMany({
      where: { companyId, validFrom: { lte: day } },
      select: { positionId: true, validFrom: true, source: true },
    }),
    db.orgReportingLine.findMany({
      where: { companyId, kind: 'direct', ...validOn(day) },
      select: { fromPositionId: true, toPositionId: true },
    }),
    db.orgAssignment.findMany({
      where: { companyId, ...validOn(day) },
      select: { personId: true, positionId: true, kind: true, timeShare: true },
    }),
    db.orgAssignment.findMany({
      where: { companyId, kind: 'primary', validTo: { lte: day } },
      select: { positionId: true, validTo: true },
    }),
    people.employed(companyId, null, asOf),
  ]);

  const started = new Map<string, string>();
  const proposedFrom = new Map<string, string>();
  for (const v of starts) {
    const from = dayOf(v.validFrom);
    if (!started.has(v.positionId) || from < started.get(v.positionId)!)
      started.set(v.positionId, from);
    if (
      v.source === 'proposed' &&
      (!proposedFrom.has(v.positionId) || from < proposedFrom.get(v.positionId)!)
    ) {
      proposedFrom.set(v.positionId, from);
    }
  }
  const lastEnd = new Map<string, string>();
  for (const a of ended) {
    const to = dayOf(a.validTo!);
    if (!lastEnd.has(a.positionId) || to > lastEnd.get(a.positionId)!)
      lastEnd.set(a.positionId, to);
  }
  const withPrimary = new Set<string>();
  const filled = new Set<string>();
  for (const a of assignments) {
    if (a.kind !== 'primary') continue;
    withPrimary.add(a.positionId);
    if (employed.has(a.personId)) filled.add(a.positionId);
  }

  return {
    companyId,
    asOf,
    units: units.map((u) => ({
      id: u.unitId,
      parentId: u.parentUnitId,
      supervisorPositionId: u.supervisorPositionId,
    })),
    positions: positions.map((p) => {
      const start = started.get(p.positionId) ?? asOf;
      const end = lastEnd.get(p.positionId);
      return {
        id: p.positionId,
        unitId: p.unitId,
        titleFa: p.titleFa,
        titleEn: p.titleEn,
        supervisory: p.supervisory,
        status: p.status as 'active' | 'frozen',
        proposedSince: p.source === 'proposed' ? (proposedFrom.get(p.positionId) ?? start) : null,
        vacantSince: withPrimary.has(p.positionId) ? null : end && end > start ? end : start,
        filled: filled.has(p.positionId),
      };
    }),
    directLines: lines.map((l) => ({ from: l.fromPositionId, to: l.toPositionId })),
    assignments: assignments.map((a) => ({
      personId: a.personId,
      positionId: a.positionId,
      kind: a.kind as orgV1.AssignmentKind,
      timeShare: a.timeShare.toNumber(),
    })),
    employed: [...employed].sort(),
  };
}

import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { Permissions } from '../../../../platform/auth/roles';
import { ScopedDb } from '../../../../platform/scope/scoped-db';
import { dateOf, validOn } from '../model/period';
import { OrgService } from '../service/org.service';
import { replay, structureAt } from './replay';

export interface AuditCheck {
  companyId: string;
  asOf: string;
  rowsReplayed: number;
  units: number;
  positions: number;
  assignments: number;
  /** Rows that could not be replayed (written before S10, or seeded without audit). */
  gaps: { action: string; entityId: string; why: string }[];
  /** Where the replay and the live structure differ; empty = they are the same. */
  differences: string[];
  same: boolean;
}

/**
 * Spec §11: "the structure as of date X equals its reconstruction from the audit log". Rebuilds the
 * structure from the company's org audit rows alone and compares it with what `get_structure` and
 * the assignments say on that date. Needs the audit-read permission (auditors).
 */
@Injectable()
export class OrgAuditReplay {
  constructor(
    private readonly db: ScopedDb,
    private readonly org: OrgService,
  ) {}

  async check(companyId: string, asOf: platformV1.BusinessDate): Promise<AuditCheck> {
    const audit = await this.db.forCompany(Permissions.auditRead, companyId);
    const rows = await audit.auditLog.findMany({
      where: { companyId, entityType: { in: ['org_unit', 'org_position', 'org_assignment'] } },
      orderBy: { seq: 'asc' },
      select: { seq: true, action: true, entityType: true, entityId: true, after: true },
    });
    const replayed = replay(rows);
    const rebuilt = structureAt(replayed, asOf);

    const live = await this.org.getStructure({ companyId, asOf });
    const assignments = await this.db.afterOwnCheck().orgAssignment.findMany({
      where: { companyId, ...validOn(dateOf(asOf)) },
      select: { id: true, personId: true, positionId: true, kind: true },
    });

    const differences: string[] = [];
    const differ = (what: string, a: unknown, b: unknown) => {
      if (JSON.stringify(a) !== JSON.stringify(b))
        differences.push(`${what}: log ${JSON.stringify(b)} ≠ live ${JSON.stringify(a)}`);
    };
    for (const u of live.units) {
      const r = rebuilt.units.get(u.id);
      if (!r) {
        differences.push(`unit ${u.code} is live but not in the log`);
        continue;
      }
      differ(`unit ${u.code} name`, u.name.fa, r.nameFa);
      differ(`unit ${u.code} parent`, u.parentUnitId, r.parentUnitId);
      differ(`unit ${u.code} level`, u.levelId, r.levelId);
      differ(`unit ${u.code} supervisor`, u.supervisorPositionId, r.supervisorPositionId);
    }
    for (const id of rebuilt.units.keys()) {
      if (!live.units.some((u) => u.id === id))
        differences.push(`unit ${id} is in the log but not live`);
    }
    for (const p of live.positions) {
      const r = rebuilt.positions.get(p.id);
      if (!r) {
        differences.push(`position ${p.code} is live but not in the log`);
        continue;
      }
      differ(`position ${p.code} title`, p.title.fa, r.titleFa);
      differ(`position ${p.code} unit`, p.unitId, r.unitId);
      differ(`position ${p.code} supervisory`, p.supervisory, r.supervisory);
      differ(`position ${p.code} status`, p.status, r.status);
      differ(`position ${p.code} type`, p.type, r.type);
      differ(`position ${p.code} fte`, p.fte, r.fte);
      differ(`position ${p.code} reports to`, p.reportsToPositionId, r.reportsToPositionId);
    }
    for (const id of rebuilt.positions.keys()) {
      if (!live.positions.some((p) => p.id === id))
        differences.push(`position ${id} is in the log but not live`);
    }
    const key = (a: { personId: string; positionId: string; kind: string }) =>
      `${a.personId}|${a.positionId}|${a.kind}`;
    const liveAssignments = new Set(assignments.map(key));
    const loggedAssignments = new Set(rebuilt.assignments.map(key));
    for (const k of liveAssignments)
      if (!loggedAssignments.has(k)) differences.push(`assignment ${k} is live but not in the log`);
    for (const k of loggedAssignments)
      if (!liveAssignments.has(k)) differences.push(`assignment ${k} is in the log but not live`);

    return {
      companyId,
      asOf,
      rowsReplayed: rows.length,
      units: rebuilt.units.size,
      positions: rebuilt.positions.size,
      assignments: rebuilt.assignments.length,
      gaps: replayed.gaps.map(({ action, entityId, why }) => ({ action, entityId, why })),
      differences,
      same: differences.length === 0,
    };
  }
}

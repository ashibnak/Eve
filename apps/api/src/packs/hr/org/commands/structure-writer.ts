import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { orgV1, platformV1 } from '@eve/contracts';
import type { z } from 'zod';
import { AuditService } from '../../../../platform/audit/audit.service';
import { Clock } from '../../../../platform/context/clock';
import { type Tx } from '../../../../platform/context/tx-runner';
import { type EventDefinition } from '../../../../platform/events/event-registry';
import { ManagerChanged, PositionChanged, PositionCreated } from '../events/org.events';
import { OrgEventSink } from '../events/org-event-sink';
import type { Current } from '../import/structure-model';
import { dateOf } from '../model/period';
import type { OrgSnapshot } from '../rules/index';
import { managerChanges } from '../rules/managers';
import { NEW_POSITION, NEW_UNIT, positionKey, unitKey } from './change-plan';

export interface WriteRequest {
  companyId: string;
  effectiveDate: platformV1.BusinessDate;
  today: platformV1.BusinessDate;
  operations: readonly orgV1.ChangeOperation[];
  current: Current;
  before: OrgSnapshot;
  whatIf: OrgSnapshot;
  reason: string;
}

/**
 * Writes a planned structure change (spec §8) in the caller's transaction: new units and
 * positions get system codes, changed ones a new version from the effective date (the old one is
 * closed, never rewritten), closed ones end there; reporting lines likewise. One audit row per
 * operation; events on the effective date.
 */
@Injectable()
export class StructureWriter {
  constructor(
    private readonly audit: AuditService,
    private readonly events: OrgEventSink,
    private readonly clock: Clock,
  ) {}

  async write(tx: Tx, request: WriteRequest): Promise<Map<string, string>> {
    const { companyId, effectiveDate, operations, current } = request;
    const now = this.clock.now();
    const from = dateOf(effectiveDate);
    const creates = {
      units: operations.filter((o) => o.op === 'unit.create'),
      positions: operations.filter((o) => o.op === 'position.create'),
    };
    const counters = await tx.orgCompany.update({
      where: { companyId },
      data: {
        nextUnitNo: { increment: creates.units.length },
        nextPositionNo: { increment: creates.positions.length },
        updatedAt: now,
      },
      select: { codePrefix: true, nextUnitNo: true, nextPositionNo: true },
    });
    const real = new Map<string, string>();
    const codes = new Map<string, string>();
    for (const [i, op] of creates.units.entries()) {
      const id = randomUUID();
      real.set(`${NEW_UNIT}${op.ref}`, id);
      codes.set(
        id,
        `${counters.codePrefix}-U${String(counters.nextUnitNo - creates.units.length + i).padStart(4, '0')}`,
      );
      await tx.orgUnit.create({ data: { id, companyId, code: codes.get(id)!, createdAt: now } });
    }
    for (const [i, op] of creates.positions.entries()) {
      const id = randomUUID();
      real.set(`${NEW_POSITION}${op.ref}`, id);
      codes.set(
        id,
        `${counters.codePrefix}-P${String(counters.nextPositionNo - creates.positions.length + i).padStart(5, '0')}`,
      );
      await tx.orgPosition.create({
        data: { id, companyId, code: codes.get(id)!, createdAt: now },
      });
    }
    const unitId = (r: orgV1.EntityRef) => real.get(unitKey(r)) ?? unitKey(r);
    const positionId = (r: orgV1.EntityRef) => real.get(positionKey(r)) ?? positionKey(r);
    const units = new Map(current.units.map((u) => [u.id, u]));
    const positions = new Map(current.positions.map((p) => [p.id, p]));
    const audit = (
      action: string,
      entityType: string,
      entityId: string,
      before: unknown,
      after: unknown,
    ) =>
      this.audit.record(tx, {
        action,
        entityType,
        entityId,
        companyId,
        before,
        after,
        reason: request.reason,
      });
    const setLine = async (from_: string, to: string | null) => {
      const existing = positions.get(from_)?.line;
      if (existing)
        await tx.orgReportingLine.update({ where: { id: existing.id }, data: { validTo: from } });
      if (to) {
        await tx.orgReportingLine.create({
          data: {
            companyId,
            fromPositionId: from_,
            toPositionId: to,
            kind: 'direct',
            validFrom: from,
            recordedAt: now,
          },
        });
      }
    };
    const emit = <S extends z.ZodType>(event: EventDefinition<S>, payload: z.input<S>) =>
      this.events.emit(
        tx,
        { event, payload, effectiveAt: effectiveDate, companyId },
        request.today,
      );

    // Units first (positions sit in them), positions next (units name supervisors), then lines.
    for (const op of operations) {
      if (op.op === 'unit.create') {
        const id = unitId({ ref: op.ref });
        const data = {
          legacyCode: op.legacyCode ?? null,
          nameFa: op.nameFa,
          nameEn: op.nameEn ?? null,
          levelId: op.levelId,
          parentUnitId: unitId(op.parent),
          costCenter: op.costCenter ?? null,
          location: op.location ?? null,
        };
        await tx.orgUnitVersion.create({
          data: {
            ...data,
            unitId: id,
            companyId,
            supervisorPositionId: null,
            status: 'active',
            validFrom: from,
            recordedAt: now,
          },
        });
        await audit('org.unit.create', 'org_unit', id, null, {
          code: codes.get(id),
          validFrom: effectiveDate,
          ...data,
        });
      } else if (op.op === 'unit.update' || op.op === 'unit.close') {
        const before = units.get(op.unitId)!;
        await tx.orgUnitVersion.update({
          where: { id: before.versionId },
          data: { validTo: from },
        });
        const old = {
          legacyCode: before.legacyCode,
          nameFa: before.nameFa,
          nameEn: before.nameEn,
          levelId: before.levelId,
          parentUnitId: before.parentUnitId,
          costCenter: before.costCenter,
          location: before.location,
          supervisorPositionId: before.supervisorPositionId,
        };
        if (op.op === 'unit.close') {
          await audit('org.unit.close', 'org_unit', op.unitId, old, { validTo: effectiveDate });
          continue;
        }
        const c = op.changes;
        const next = {
          ...old,
          ...(c.nameFa !== undefined ? { nameFa: c.nameFa } : {}),
          ...(c.nameEn !== undefined ? { nameEn: c.nameEn } : {}),
          ...(c.levelId !== undefined ? { levelId: c.levelId } : {}),
          ...(c.parent ? { parentUnitId: unitId(c.parent) } : {}),
          ...(c.costCenter !== undefined ? { costCenter: c.costCenter } : {}),
          ...(c.location !== undefined ? { location: c.location } : {}),
          // A supervisor that the bundle creates is set below, once the position exists.
          ...(c.supervisor === null ? { supervisorPositionId: null } : {}),
          ...(c.supervisor && 'id' in c.supervisor
            ? { supervisorPositionId: c.supervisor.id }
            : {}),
        };
        await tx.orgUnitVersion.create({
          data: {
            ...next,
            unitId: op.unitId,
            companyId,
            status: 'active',
            validFrom: from,
            recordedAt: now,
          },
        });
        await audit('org.unit.change', 'org_unit', op.unitId, old, {
          validFrom: effectiveDate,
          ...next,
        });
      }
    }
    for (const op of operations) {
      if (op.op === 'position.create') {
        const id = positionId({ ref: op.ref });
        const data = {
          legacyCode: op.legacyCode ?? null,
          titleFa: op.titleFa,
          titleEn: op.titleEn ?? null,
          unitId: unitId(op.unit),
          type: op.type,
          fte: String(op.fte),
          supervisory: op.supervisory,
        };
        await tx.orgPositionVersion.create({
          data: {
            ...data,
            positionId: id,
            companyId,
            jobId: null,
            status: 'active',
            source: 'official',
            validFrom: from,
            recordedAt: now,
          },
        });
        await audit('org.position.create', 'org_position', id, null, {
          code: codes.get(id),
          validFrom: effectiveDate,
          ...data,
          reportsTo: op.reportsTo ? positionId(op.reportsTo) : null,
        });
        await emit(PositionCreated, {
          position_id: id,
          code: codes.get(id)!,
          unit_id: data.unitId,
          job_id: null,
          supervisory: op.supervisory,
        });
      } else if (op.op === 'position.update' || op.op === 'position.close') {
        const before = positions.get(op.positionId)!;
        const old = {
          legacyCode: before.legacyCode,
          titleFa: before.titleFa,
          titleEn: before.titleEn,
          unitId: before.unitId,
          jobId: before.jobId,
          type: before.type,
          fte: before.fte,
          supervisory: before.supervisory,
          status: before.status,
          source: before.source,
          reportsTo: before.line?.to ?? null,
        };
        if (op.op === 'position.close') {
          await tx.orgPositionVersion.update({
            where: { id: before.versionId },
            data: { validTo: from },
          });
          await audit('org.position.close', 'org_position', op.positionId, old, {
            validTo: effectiveDate,
          });
          continue;
        }
        const c = op.changes;
        const versionChanges = Object.keys(c).some((k) => k !== 'reportsTo');
        const next = {
          ...old,
          ...(c.titleFa !== undefined ? { titleFa: c.titleFa } : {}),
          ...(c.titleEn !== undefined ? { titleEn: c.titleEn } : {}),
          ...(c.unit ? { unitId: unitId(c.unit) } : {}),
          ...(c.type !== undefined ? { type: c.type } : {}),
          ...(c.fte !== undefined ? { fte: c.fte } : {}),
          ...(c.supervisory !== undefined ? { supervisory: c.supervisory } : {}),
          ...(c.status !== undefined ? { status: c.status } : {}),
          reportsTo:
            c.reportsTo === undefined
              ? old.reportsTo
              : c.reportsTo
                ? positionId(c.reportsTo)
                : null,
        };
        if (versionChanges) {
          await tx.orgPositionVersion.update({
            where: { id: before.versionId },
            data: { validTo: from },
          });
          const { reportsTo: _reportsTo, ...version } = next;
          void _reportsTo;
          await tx.orgPositionVersion.create({
            data: {
              ...version,
              fte: String(version.fte),
              positionId: op.positionId,
              companyId,
              validFrom: from,
              recordedAt: now,
            },
          });
        }
        await audit('org.position.change', 'org_position', op.positionId, old, {
          validFrom: effectiveDate,
          ...next,
        });
        if (next.unitId !== old.unitId) {
          await emit(PositionChanged, {
            position_id: op.positionId,
            changed: ['unit'],
            unit_from: old.unitId,
            unit_to: next.unitId,
            job_from: old.jobId,
            job_to: old.jobId,
          });
        }
      }
    }
    // Reporting lines and supervisors that point at positions created above.
    for (const op of operations) {
      if (op.op === 'position.create' && op.reportsTo) {
        await setLine(positionId({ ref: op.ref }), positionId(op.reportsTo));
      } else if (op.op === 'position.update' && op.changes.reportsTo !== undefined) {
        await setLine(
          op.positionId,
          op.changes.reportsTo ? positionId(op.changes.reportsTo) : null,
        );
      } else if (op.op === 'position.close') {
        await setLine(op.positionId, null);
      } else if (op.op === 'unit.create' && op.supervisor) {
        await this.setSupervisor(tx, unitId({ ref: op.ref }), from, positionId(op.supervisor));
      } else if (
        op.op === 'unit.update' &&
        op.changes.supervisor &&
        'ref' in op.changes.supervisor
      ) {
        await this.setSupervisor(tx, op.unitId, from, positionId(op.changes.supervisor));
      }
    }

    for (const change of managerChanges(request.before, request.whatIf)) {
      await emit(ManagerChanged, {
        person_id: change.personId,
        from_manager_person_id: change.from,
        to_manager_person_id: change.to,
      });
    }
    return real;
  }

  /** Points the unit version that starts on the effective date at a supervisor position. */
  private async setSupervisor(
    tx: Tx,
    unitId: string,
    from: Date,
    positionId: string,
  ): Promise<void> {
    const version = await tx.orgUnitVersion.findFirstOrThrow({
      where: { unitId, validFrom: from },
      select: { id: true },
    });
    await tx.orgUnitVersion.update({
      where: { id: version.id },
      data: { supervisorPositionId: positionId },
    });
  }
}

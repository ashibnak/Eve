import type { orgV1, platformV1 } from '@eve/contracts';
import type { Current } from '../import/structure-model';
import type { OrgSnapshot } from '../rules/index';

export const NEW_UNIT = 'new-unit:';
export const NEW_POSITION = 'new-position:';

/** The snapshot id of a unit or position reference (an existing id, or a ref the bundle creates). */
export const unitKey = (r: orgV1.EntityRef) => ('id' in r ? r.id : `${NEW_UNIT}${r.ref}`);
export const positionKey = (r: orgV1.EntityRef) => ('id' in r ? r.id : `${NEW_POSITION}${r.ref}`);

export interface ChangePlan {
  /** Problems that make the bundle invalid (shown to the requester; nothing is written). */
  errors: string[];
  whatIf: OrgSnapshot;
}

/**
 * Applies a change request's operations to the structure on the effective date, in memory: checks
 * that every operation makes sense there and returns the structure that would result (for the
 * rules and the impact analysis). Writing it is `StructureWriter`'s job.
 */
export function planChange(input: {
  effectiveDate: platformV1.BusinessDate;
  operations: readonly orgV1.ChangeOperation[];
  current: Current;
  before: OrgSnapshot;
}): ChangePlan {
  const { effectiveDate, operations, current, before } = input;
  const errors: string[] = [];
  const units = new Map(before.units.map((u) => [u.id, { ...u }]));
  const positions = new Map(before.positions.map((p) => [p.id, { ...p }]));
  const lines = new Map(before.directLines.map((l) => [l.from, l.to]));
  const levels = new Set(current.levels.values());
  const currentUnits = new Map(current.units.map((u) => [u.id, u]));
  const currentPositions = new Map(current.positions.map((p) => [p.id, p]));
  const incumbents = new Set(current.assignments.map((a) => a.positionId));
  const touched = new Set<string>();
  const refs = new Set<string>();
  const closedUnits = new Set<string>();

  const touch = (id: string, label: string, versionFrom: platformV1.BusinessDate | undefined) => {
    if (touched.has(id)) errors.push(`${label} appears in more than one operation`);
    touched.add(id);
    if (current.laterChanged.has(id)) {
      errors.push(`${label} already has a change after ${effectiveDate}`);
    } else if (versionFrom === effectiveDate) {
      errors.push(
        `${label} was already changed on ${effectiveDate}; correct it or pick another date`,
      );
    }
  };
  const newRef = (key: string, label: string) => {
    if (refs.has(key)) errors.push(`${label}: ref is used twice`);
    refs.add(key);
  };

  for (const [index, op] of operations.entries()) {
    const label = `Operation ${index + 1} (${op.op})`;
    switch (op.op) {
      case 'unit.create': {
        const id = `${NEW_UNIT}${op.ref}`;
        newRef(id, label);
        if (!levels.has(op.levelId)) errors.push(`${label}: unknown unit level`);
        units.set(id, {
          id,
          parentId: unitKey(op.parent),
          supervisorPositionId: op.supervisor ? positionKey(op.supervisor) : null,
        });
        break;
      }
      case 'unit.update': {
        const unit = units.get(op.unitId);
        if (!unit || !currentUnits.has(op.unitId)) {
          errors.push(`${label}: no such unit on ${effectiveDate}`);
          break;
        }
        touch(op.unitId, label, currentUnits.get(op.unitId)!.validFrom);
        if (op.changes.levelId && !levels.has(op.changes.levelId))
          errors.push(`${label}: unknown unit level`);
        if (op.changes.parent) unit.parentId = unitKey(op.changes.parent);
        if (op.changes.supervisor !== undefined) {
          unit.supervisorPositionId = op.changes.supervisor
            ? positionKey(op.changes.supervisor)
            : null;
        }
        break;
      }
      case 'unit.close': {
        if (!units.has(op.unitId) || !currentUnits.has(op.unitId)) {
          errors.push(`${label}: no such unit on ${effectiveDate}`);
          break;
        }
        touch(op.unitId, label, currentUnits.get(op.unitId)!.validFrom);
        units.delete(op.unitId);
        closedUnits.add(op.unitId);
        break;
      }
      case 'position.create': {
        const id = `${NEW_POSITION}${op.ref}`;
        newRef(id, label);
        positions.set(id, {
          id,
          unitId: unitKey(op.unit),
          titleFa: op.titleFa,
          titleEn: op.titleEn ?? null,
          supervisory: op.supervisory,
          status: 'active',
          proposedSince: null,
          vacantSince: effectiveDate,
          filled: false,
        });
        if (op.reportsTo) lines.set(id, positionKey(op.reportsTo));
        break;
      }
      case 'position.update': {
        const position = positions.get(op.positionId);
        const existing = currentPositions.get(op.positionId);
        if (!position || !existing) {
          errors.push(`${label}: no such position on ${effectiveDate}`);
          break;
        }
        const versionChanges = Object.keys(op.changes).filter((k) => k !== 'reportsTo');
        const from =
          versionChanges.length > 0
            ? existing.validFrom
            : op.changes.reportsTo !== undefined
              ? existing.line?.validFrom
              : undefined;
        touch(op.positionId, label, from);
        if (
          versionChanges.length > 0 &&
          op.changes.reportsTo !== undefined &&
          existing.line?.validFrom === effectiveDate
        ) {
          errors.push(`${label}: its reporting line was already changed on ${effectiveDate}`);
        }
        const c = op.changes;
        if (c.unit) position.unitId = unitKey(c.unit);
        if (c.titleFa !== undefined) position.titleFa = c.titleFa;
        if (c.titleEn !== undefined) position.titleEn = c.titleEn;
        if (c.supervisory !== undefined) position.supervisory = c.supervisory;
        if (c.status !== undefined) position.status = c.status;
        if (c.reportsTo === null) lines.delete(op.positionId);
        else if (c.reportsTo) lines.set(op.positionId, positionKey(c.reportsTo));
        break;
      }
      case 'position.close': {
        const existing = currentPositions.get(op.positionId);
        if (!positions.has(op.positionId) || !existing) {
          errors.push(`${label}: no such position on ${effectiveDate}`);
          break;
        }
        touch(op.positionId, label, existing.validFrom);
        // Decision 2026-11-25: a filled position is vacated by a personnel action first.
        if (incumbents.has(op.positionId)) {
          errors.push(
            `${label}: the position has incumbents; vacate it with a personnel action first`,
          );
        }
        positions.delete(op.positionId);
        lines.delete(op.positionId);
        break;
      }
    }
  }

  // References must point at something that exists after the bundle.
  for (const u of units.values()) {
    if (u.parentId && !units.has(u.parentId)) {
      errors.push(
        `Unit ${u.id}: its parent ${closedUnits.has(u.parentId) ? 'is closed' : 'does not exist'}`,
      );
    }
    if (u.supervisorPositionId && !positions.has(u.supervisorPositionId)) {
      errors.push(`Unit ${u.id}: its supervisor position does not exist`);
    }
  }
  for (const p of positions.values()) {
    if (!units.has(p.unitId)) {
      errors.push(
        `Position ${p.id}: its unit ${closedUnits.has(p.unitId) ? 'is closed' : 'does not exist'}`,
      );
    }
  }
  for (const [from, to] of lines) {
    if (positions.has(from) && !positions.has(to))
      errors.push(`Position ${from} reports to a position that does not exist`);
  }

  const assignments = before.assignments.filter((a) => positions.has(a.positionId));
  const employed = new Set(before.employed);
  const filled = new Set(
    assignments
      .filter((a) => a.kind === 'primary' && employed.has(a.personId))
      .map((a) => a.positionId),
  );
  return {
    errors,
    whatIf: {
      ...before,
      units: [...units.values()],
      positions: [...positions.values()].map((p) => ({ ...p, filled: filled.has(p.id) })),
      directLines: [...lines.entries()]
        .filter(([from]) => positions.has(from))
        .map(([from, to]) => ({ from, to })),
      assignments,
    },
  };
}

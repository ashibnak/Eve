import type { platformV1 } from '@eve/contracts';
import type { DiffEntry, Finding } from '../../../../platform/connectors/import-target';
import type { OrgSnapshot } from '../rules/index';
import type {
  Current,
  CurrentPosition,
  CurrentUnit,
  FileAssignment,
  FileModel,
  FilePosition,
  FileUnit,
} from './structure-model';

export interface AddedAssignment {
  file: FileAssignment;
  personId: string;
  positionRef: string;
}

/** What committing the file would do, worked out against the structure on the effective date. */
export interface ImportPlan {
  findings: Finding[];
  /** File unit/position code → existing id, or `new-unit:<code>` / `new-position:<code>`. */
  unitRef: Map<string, string>;
  positionRef: Map<string, string>;
  units: {
    added: FileUnit[];
    changed: { file: FileUnit; current: CurrentUnit }[];
    removed: CurrentUnit[];
  };
  positions: {
    added: FilePosition[];
    changed: { file: FilePosition; current: CurrentPosition; unitChanged: boolean }[];
    /** Kept positions whose direct line changes (with or without a new version). */
    lineChanged: { file: FilePosition; current: CurrentPosition }[];
    removed: CurrentPosition[];
  };
  assignments: { added: AddedAssignment[] };
  whatIf: OrgSnapshot;
  diff: DiffEntry[];
}

const NEW_UNIT = 'new-unit:';
const NEW_POSITION = 'new-position:';
export const isNew = (ref: string) => ref.startsWith(NEW_UNIT) || ref.startsWith(NEW_POSITION);

/**
 * Matches the file to the current structure (by legacy code, or by system code when the file
 * uses it; proposed positions by unit and title) and lists every change, the problems that stop
 * the commit, and the structure that would result (for the rules).
 */
export function planImport(input: {
  companyId: string;
  effectiveDate: platformV1.BusinessDate;
  file: FileModel;
  current: Current;
  personIds: ReadonlyMap<string, string>;
  employed: ReadonlySet<string>;
}): ImportPlan {
  const { file, current, effectiveDate } = input;
  const findings: Finding[] = [];
  const block = (
    code: string,
    message: string,
    at?: { entity: string; key: string; rowNumber?: number },
  ) => findings.push({ severity: 'blocking', code, message, ...at });
  const warn = (
    code: string,
    message: string,
    at?: { entity: string; key: string; rowNumber?: number },
  ) => findings.push({ severity: 'warning', code, message, ...at });

  // ── Match units ─────────────────────────────────────────────────────────────
  const unitByCode = new Map<string, CurrentUnit>();
  for (const u of current.units) {
    unitByCode.set(u.code, u);
    if (u.legacyCode) unitByCode.set(u.legacyCode, u);
  }
  const unitRef = new Map<string, string>();
  for (const u of file.units.values())
    unitRef.set(u.code, unitByCode.get(u.code)?.id ?? `${NEW_UNIT}${u.code}`);
  const keptUnits = new Set([...unitRef.values()].filter((r) => !isNew(r)));

  // ── Match positions ─────────────────────────────────────────────────────────
  const positionByCode = new Map<string, CurrentPosition>();
  const proposedByUnitTitle = new Map<string, CurrentPosition>();
  for (const p of current.positions) {
    positionByCode.set(p.code, p);
    if (p.legacyCode) positionByCode.set(p.legacyCode, p);
    if (p.source === 'proposed') proposedByUnitTitle.set(`${p.unitId}|${p.titleFa}`, p);
  }
  const positionRef = new Map<string, string>();
  for (const p of file.positions.values()) {
    const unit = unitRef.get(p.unitCode);
    const existing = p.proposed
      ? unit === undefined
        ? undefined
        : proposedByUnitTitle.get(`${unit}|${p.titleFa}`)
      : positionByCode.get(p.code);
    positionRef.set(p.code, existing?.id ?? `${NEW_POSITION}${p.code}`);
  }
  const keptPositions = new Set([...positionRef.values()].filter((r) => !isNew(r)));

  // ── References inside the file ──────────────────────────────────────────────
  for (const u of file.units.values()) {
    const at = { entity: 'unit', key: u.code, rowNumber: u.rowNumber };
    if (!current.levels.has(u.level) && !current.levels.has(u.level.toLowerCase())) {
      block(
        'org.import.unknown_level',
        `Unit ${u.code}: level "${u.level}" is not one of the company's levels`,
        at,
      );
    }
    if (u.parentCode !== null && !file.units.has(u.parentCode)) {
      block(
        'org.import.unknown_parent',
        `Unit ${u.code}: parent unit ${u.parentCode} is not in the file`,
        at,
      );
    }
    if (u.supervisorCode !== null && !file.positions.has(u.supervisorCode)) {
      block(
        'org.import.unknown_supervisor',
        `Unit ${u.code}: supervisor position ${u.supervisorCode} is not in the file`,
        at,
      );
    }
  }
  for (const p of file.positions.values()) {
    const at = { entity: 'position', key: p.code, rowNumber: p.rowNumber };
    if (!file.units.has(p.unitCode)) {
      block(
        'org.import.unknown_unit',
        `Position ${p.code}: unit ${p.unitCode} is not in the file`,
        at,
      );
    }
    if (p.reportsToCode !== null && !file.positions.has(p.reportsToCode)) {
      block(
        'org.import.unknown_manager_position',
        `Position ${p.code}: reports to ${p.reportsToCode}, which is not in the file`,
        at,
      );
    }
  }
  const addedAssignments: AddedAssignment[] = [];
  const kept = current.assignments.filter((a) => keptPositions.has(a.positionId));
  const existingKey = new Set(kept.map((a) => `${a.personId}|${a.positionId}|${a.kind}`));
  const inFile = new Set<string>();
  for (const a of file.assignments) {
    const at = {
      entity: 'assignment',
      key: `${a.personnelCode}|${a.positionCode}|${a.kind}`,
      rowNumber: a.rowNumber,
    };
    const personId = input.personIds.get(a.personnelCode);
    if (!personId) {
      block(
        'org.import.unknown_person',
        `Personnel code ${a.personnelCode} is not in the person register`,
        at,
      );
      continue;
    }
    if (!a.positionCode) {
      block(
        'org.import.no_position',
        `Row needs a position code, or a unit code and a title (proposed position)`,
        at,
      );
      continue;
    }
    const ref = positionRef.get(a.positionCode);
    if (!ref) {
      block('org.import.unknown_position', `Position ${a.positionCode} is not in the file`, at);
      continue;
    }
    const key = `${personId}|${ref}|${a.kind}`;
    inFile.add(key);
    if (!existingKey.has(key)) addedAssignments.push({ file: a, personId, positionRef: ref });
  }
  for (const a of kept) {
    if (!inFile.has(`${a.personId}|${a.positionId}|${a.kind}`)) {
      const position = current.positions.find((p) => p.id === a.positionId)!;
      warn(
        'org.import.assignment_not_in_file',
        `An assignment (${a.kind}) on position ${position.legacyCode ?? position.code} is not in the file; it stays until a personnel action ends it`,
        { entity: 'assignment', key: a.id },
      );
    }
  }

  // ── Removals ────────────────────────────────────────────────────────────────
  const removedUnits = current.units.filter((u) => !keptUnits.has(u.id));
  const removedPositions = current.positions.filter((p) => !keptPositions.has(p.id));
  const filled = new Set(current.assignments.map((a) => a.positionId));
  for (const p of removedPositions) {
    if (filled.has(p.id)) {
      block(
        'org.import.remove_filled',
        `Position ${p.legacyCode ?? p.code} is not in the file but has incumbents; vacate it with a personnel action first`,
        { entity: 'position', key: p.legacyCode ?? p.code },
      );
    }
  }

  // ── Changes ─────────────────────────────────────────────────────────────────
  const levelOf = (name: string) =>
    current.levels.get(name) ?? current.levels.get(name.toLowerCase()) ?? null;
  const ref = (map: Map<string, string>, code: string | null) =>
    code === null ? null : (map.get(code) ?? null);
  const unitSig = (u: FileUnit) => ({
    nameFa: u.nameFa,
    nameEn: u.nameEn,
    levelId: levelOf(u.level),
    parent: ref(unitRef, u.parentCode),
    costCenter: u.costCenter,
    location: u.location,
    supervisor: ref(positionRef, u.supervisorCode),
  });
  const currentUnitSig = (u: CurrentUnit) => ({
    nameFa: u.nameFa,
    nameEn: u.nameEn,
    levelId: u.levelId,
    parent: u.parentUnitId,
    costCenter: u.costCenter,
    location: u.location,
    supervisor: u.supervisorPositionId,
  });
  const positionSig = (p: FilePosition) => ({
    titleFa: p.titleFa,
    titleEn: p.titleEn,
    unit: ref(unitRef, p.unitCode),
    type: p.type,
    fte: p.fte,
    supervisory: p.supervisory,
    status: p.status,
  });
  const currentPositionSig = (p: CurrentPosition) => ({
    titleFa: p.titleFa,
    titleEn: p.titleEn,
    unit: p.unitId,
    type: p.type,
    fte: p.fte,
    supervisory: p.supervisory,
    status: p.status,
  });
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const units: ImportPlan['units'] = { added: [], changed: [], removed: removedUnits };
  for (const u of file.units.values()) {
    const existing = current.units.find((c) => c.id === unitRef.get(u.code));
    if (!existing) units.added.push(u);
    else if (!same(unitSig(u), currentUnitSig(existing)))
      units.changed.push({ file: u, current: existing });
  }
  const positions: ImportPlan['positions'] = {
    added: [],
    changed: [],
    lineChanged: [],
    removed: removedPositions,
  };
  for (const p of file.positions.values()) {
    const existing = current.positions.find((c) => c.id === positionRef.get(p.code));
    if (!existing) {
      positions.added.push(p);
      continue;
    }
    if (!same(positionSig(p), currentPositionSig(existing))) {
      positions.changed.push({
        file: p,
        current: existing,
        unitChanged: ref(unitRef, p.unitCode) !== existing.unitId,
      });
    }
    if (ref(positionRef, p.reportsToCode) !== (existing.line?.to ?? null)) {
      positions.lineChanged.push({ file: p, current: existing });
    }
  }

  // ── Dated history: no change at or before a later recorded change ──────────
  const touched: { id: string; label: string; from: platformV1.BusinessDate | null }[] = [
    ...units.changed.map((c) => ({
      id: c.current.id,
      label: `Unit ${c.file.code}`,
      from: c.current.validFrom,
    })),
    ...units.removed.map((u) => ({
      id: u.id,
      label: `Unit ${u.legacyCode ?? u.code}`,
      from: u.validFrom,
    })),
    ...positions.changed.map((c) => ({
      id: c.current.id,
      label: `Position ${c.file.code}`,
      from: c.current.validFrom,
    })),
    ...positions.removed.map((p) => ({
      id: p.id,
      label: `Position ${p.legacyCode ?? p.code}`,
      from: p.validFrom,
    })),
    ...positions.lineChanged.map((c) => ({
      id: c.current.id,
      label: `Reporting line of ${c.file.code}`,
      from: c.current.line?.validFrom ?? null,
    })),
  ];
  for (const t of touched) {
    if (current.laterChanged.has(t.id)) {
      block(
        'org.import.later_change',
        `${t.label} already has a change after ${effectiveDate}; import from a later date`,
      );
    } else if (t.from === effectiveDate) {
      block(
        'org.import.same_day_change',
        `${t.label} was already changed on ${effectiveDate}; correct it instead`,
      );
    }
  }

  // ── The structure that would result ─────────────────────────────────────────
  const finalAssignments = [
    ...kept.map((a) => ({
      personId: a.personId,
      positionId: a.positionId,
      kind: a.kind,
      timeShare: a.timeShare,
    })),
    ...addedAssignments.map((a) => ({
      personId: a.personId,
      positionId: a.positionRef,
      kind: a.file.kind,
      timeShare: a.file.timeShare,
    })),
  ];
  const withPrimary = new Set(
    finalAssignments.filter((a) => a.kind === 'primary').map((a) => a.positionId),
  );
  const filledAfter = new Set(
    finalAssignments
      .filter((a) => a.kind === 'primary' && input.employed.has(a.personId))
      .map((a) => a.positionId),
  );
  const whatIf: OrgSnapshot = {
    companyId: input.companyId,
    asOf: effectiveDate,
    units: [...file.units.values()].map((u) => ({
      id: unitRef.get(u.code)!,
      parentId: ref(unitRef, u.parentCode),
      supervisorPositionId: ref(positionRef, u.supervisorCode),
    })),
    positions: [...file.positions.values()].map((p) => {
      const id = positionRef.get(p.code)!;
      return {
        id,
        unitId: ref(unitRef, p.unitCode) ?? `${NEW_UNIT}${p.unitCode}`,
        titleFa: p.titleFa,
        titleEn: p.titleEn,
        supervisory: p.supervisory,
        status: p.status,
        proposedSince: p.proposed ? effectiveDate : null,
        vacantSince: withPrimary.has(id) ? null : effectiveDate,
        filled: filledAfter.has(id),
      };
    }),
    directLines: [...file.positions.values()].flatMap((p) => {
      const to = ref(positionRef, p.reportsToCode);
      return to ? [{ from: positionRef.get(p.code)!, to }] : [];
    }),
    assignments: finalAssignments,
    employed: [...input.employed].sort(),
  };

  // ── Preview ─────────────────────────────────────────────────────────────────
  const unitCodeOf = new Map(current.units.map((u) => [u.id, u.legacyCode ?? u.code]));
  const positionCodeOf = new Map(current.positions.map((p) => [p.id, p.legacyCode ?? p.code]));
  const levelName = new Map([...current.levels.entries()].map(([name, id]) => [id, name]));
  const showFileUnit = (u: FileUnit) => ({
    nameFa: u.nameFa,
    nameEn: u.nameEn,
    level: u.level,
    parent: u.parentCode,
    costCenter: u.costCenter,
    location: u.location,
    supervisor: u.supervisorCode,
  });
  const showCurrentUnit = (u: CurrentUnit) => ({
    nameFa: u.nameFa,
    nameEn: u.nameEn,
    level: u.levelId ? (levelName.get(u.levelId) ?? null) : null,
    costCenter: u.costCenter,
    location: u.location,
    parent: u.parentUnitId ? (unitCodeOf.get(u.parentUnitId) ?? null) : null,
    supervisor: u.supervisorPositionId
      ? (positionCodeOf.get(u.supervisorPositionId) ?? null)
      : null,
  });
  const showFilePosition = (p: FilePosition) => ({
    ...positionSig(p),
    unit: p.unitCode,
    reportsTo: p.reportsToCode,
    proposed: p.proposed,
  });
  const showCurrentPosition = (p: CurrentPosition) => ({
    ...currentPositionSig(p),
    unit: unitCodeOf.get(p.unitId) ?? null,
    reportsTo: p.line ? (positionCodeOf.get(p.line.to) ?? null) : null,
    proposed: p.source === 'proposed',
  });
  const changedUnits = new Set(units.changed.map((c) => c.file.code));
  const addedUnits = new Set(units.added.map((u) => u.code));
  const changedPositions = new Set(
    [...positions.changed, ...positions.lineChanged].map((c) => c.file.code),
  );
  const addedPositions = new Set(positions.added.map((p) => p.code));
  const diff: DiffEntry[] = [];
  for (const u of file.units.values()) {
    const existing = current.units.find((c) => c.id === unitRef.get(u.code));
    diff.push({
      entity: 'unit',
      key: u.code,
      kind: addedUnits.has(u.code) ? 'added' : changedUnits.has(u.code) ? 'changed' : 'unchanged',
      before: existing ? showCurrentUnit(existing) : null,
      after: showFileUnit(u),
      rowNumber: u.rowNumber,
    });
  }
  for (const u of removedUnits) {
    diff.push({
      entity: 'unit',
      key: u.legacyCode ?? u.code,
      kind: 'removed',
      before: showCurrentUnit(u),
      after: null,
    });
  }
  for (const p of file.positions.values()) {
    const existing = current.positions.find((c) => c.id === positionRef.get(p.code));
    diff.push({
      entity: 'position',
      key: p.code,
      kind: addedPositions.has(p.code)
        ? 'added'
        : changedPositions.has(p.code)
          ? 'changed'
          : 'unchanged',
      before: existing ? showCurrentPosition(existing) : null,
      after: showFilePosition(p),
      rowNumber: p.rowNumber,
    });
  }
  for (const p of removedPositions) {
    diff.push({
      entity: 'position',
      key: p.legacyCode ?? p.code,
      kind: 'removed',
      before: showCurrentPosition(p),
      after: null,
    });
  }
  const added = new Set(addedAssignments.map((a) => a.file));
  for (const a of file.assignments) {
    diff.push({
      entity: 'assignment',
      key: `${a.personnelCode}|${a.positionCode}|${a.kind}`,
      kind: added.has(a) ? 'added' : 'unchanged',
      before: null,
      after: {
        personnelCode: a.personnelCode,
        position: a.positionCode,
        kind: a.kind,
        timeShare: a.timeShare,
      },
      rowNumber: a.rowNumber,
    });
  }
  diff.sort((a, b) =>
    a.entity === b.entity
      ? a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : 0
      : a.entity < b.entity
        ? -1
        : 1,
  );

  return {
    findings,
    unitRef,
    positionRef,
    units,
    positions,
    assignments: { added: addedAssignments },
    whatIf,
    diff,
  };
}

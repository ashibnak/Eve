import type { orgV1 } from '@eve/contracts';
import { Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import { t } from '../i18n/t';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Select } from '../ui/kit';
import type { Structure, StructurePosition } from './api';

export type Operation = orgV1.ChangeOperation;

/**
 * The structure a change request would create, for the before/after chart. Only a preview: the
 * server plans and checks the bundle again. New items get ids `new:<ref>`.
 */
export function applyOperations(
  structure: Structure,
  operations: readonly Operation[],
): { after: Structure; changed: Set<string> } {
  const key = (r: orgV1.EntityRef) => ('id' in r ? r.id : `new:${r.ref}`);
  const units = new Map(structure.units.map((u) => [u.id, { ...u }]));
  const positions = new Map(structure.positions.map((p) => [p.id, { ...p }]));
  const changed = new Set<string>();
  for (const op of operations) {
    if (op.op === 'unit.create') {
      units.set(`new:${op.ref}`, {
        id: `new:${op.ref}`,
        companyId: structure.companyId,
        code: '',
        legacyCode: op.legacyCode ?? null,
        name: { fa: op.nameFa, en: op.nameEn ?? null },
        levelId: op.levelId,
        parentUnitId: key(op.parent),
        supervisorPositionId: op.supervisor ? key(op.supervisor) : null,
        status: 'active',
      });
    } else if (op.op === 'unit.update') {
      const u = units.get(op.unitId);
      if (!u) continue;
      if (op.changes.nameFa) u.name = { ...u.name, fa: op.changes.nameFa };
      if (op.changes.parent) u.parentUnitId = key(op.changes.parent);
    } else if (op.op === 'unit.close') {
      units.delete(op.unitId);
    } else if (op.op === 'position.create') {
      const id = `new:${op.ref}`;
      positions.set(id, {
        id,
        companyId: structure.companyId,
        code: '',
        legacyCode: op.legacyCode ?? null,
        title: { fa: op.titleFa, en: op.titleEn ?? null },
        unitId: key(op.unit),
        jobId: null,
        type: op.type,
        fte: op.fte,
        supervisory: op.supervisory,
        status: 'active',
        source: 'official',
        occupancy: 'vacant',
        reportsToPositionId: op.reportsTo ? key(op.reportsTo) : null,
        incumbentCount: 0,
        asOf: structure.asOf,
      });
      changed.add(id);
    } else if (op.op === 'position.update') {
      const p = positions.get(op.positionId);
      if (!p) continue;
      const c = op.changes;
      if (c.titleFa) p.title = { ...p.title, fa: c.titleFa };
      if (c.unit) p.unitId = key(c.unit);
      if (c.reportsTo !== undefined) p.reportsToPositionId = c.reportsTo ? key(c.reportsTo) : null;
      if (c.supervisory !== undefined) p.supervisory = c.supervisory;
      if (c.status) p.status = c.status;
      changed.add(op.positionId);
    } else if (op.op === 'position.close') {
      positions.delete(op.positionId);
    }
  }
  return {
    after: { ...structure, units: [...units.values()], positions: [...positions.values()] },
    changed,
  };
}

export type Draft =
  | { op: 'unit.create'; ref: string; nameFa: string; levelId: string; parent: string }
  | { op: 'unit.update'; unitId: string; nameFa: string; parent: string }
  | { op: 'unit.close'; unitId: string }
  | {
      op: 'position.create';
      ref: string;
      titleFa: string;
      unit: string;
      supervisory: boolean;
      reportsTo: string;
    }
  | { op: 'position.update'; position: string; titleFa: string; unit: string; reportsTo: string }
  | { op: 'position.close'; position: string };

const NEW = 'new:';

/** "new:u1" (a unit or position the bundle creates) or an existing id, as a contract reference. */
function ref(value: string): orgV1.EntityRef {
  return value.startsWith(NEW) ? { ref: value.slice(NEW.length) } : { id: value };
}

/** Drafts to operations; a position is named by its code (system or legacy). Null if incomplete. */
export function toOperations(
  drafts: readonly Draft[],
  positionByCode: ReadonlyMap<string, StructurePosition>,
): Operation[] | null {
  const position = (code: string) =>
    code.startsWith(NEW) ? code : positionByCode.get(code.trim())?.id;
  const ops: Operation[] = [];
  for (const d of drafts) {
    switch (d.op) {
      case 'unit.create':
        if (!d.nameFa || !d.levelId || !d.parent) return null;
        ops.push({
          op: d.op,
          ref: d.ref,
          nameFa: d.nameFa,
          levelId: d.levelId,
          parent: ref(d.parent),
        });
        break;
      case 'unit.update': {
        if (!d.unitId) return null;
        const changes: Extract<Operation, { op: 'unit.update' }>['changes'] = {};
        if (d.nameFa) changes.nameFa = d.nameFa;
        if (d.parent) changes.parent = ref(d.parent);
        if (Object.keys(changes).length === 0) return null;
        ops.push({ op: d.op, unitId: d.unitId, changes });
        break;
      }
      case 'unit.close':
        if (!d.unitId) return null;
        ops.push({ op: d.op, unitId: d.unitId });
        break;
      case 'position.create': {
        const reportsTo = d.reportsTo ? position(d.reportsTo) : null;
        if (!d.titleFa || !d.unit || reportsTo === undefined) return null;
        ops.push({
          op: d.op,
          ref: d.ref,
          titleFa: d.titleFa,
          unit: ref(d.unit),
          type: 'approved',
          fte: 1,
          supervisory: d.supervisory,
          reportsTo: reportsTo ? ref(reportsTo) : null,
        });
        break;
      }
      case 'position.update': {
        const id = position(d.position);
        if (!id || id.startsWith(NEW)) return null;
        const changes: Extract<Operation, { op: 'position.update' }>['changes'] = {};
        if (d.titleFa) changes.titleFa = d.titleFa;
        if (d.unit) changes.unit = ref(d.unit);
        if (d.reportsTo) {
          const to = position(d.reportsTo);
          if (!to) return null;
          changes.reportsTo = ref(to);
        }
        if (Object.keys(changes).length === 0) return null;
        ops.push({ op: d.op, positionId: id, changes });
        break;
      }
      case 'position.close': {
        const id = position(d.position);
        if (!id || id.startsWith(NEW)) return null;
        ops.push({ op: d.op, positionId: id });
        break;
      }
    }
  }
  return ops;
}

export function newDraft(op: Draft['op'], index: number): Draft {
  switch (op) {
    case 'unit.create':
      return { op, ref: `u${index}`, nameFa: '', levelId: '', parent: '' };
    case 'unit.update':
      return { op, unitId: '', nameFa: '', parent: '' };
    case 'unit.close':
      return { op, unitId: '' };
    case 'position.create':
      return { op, ref: `p${index}`, titleFa: '', unit: '', supervisory: false, reportsTo: '' };
    case 'position.update':
      return { op, position: '', titleFa: '', unit: '', reportsTo: '' };
    case 'position.close':
      return { op, position: '' };
  }
}

/** One draft operation as a small form; units are picked from a list, positions by code. */
export function OperationEditor({
  draft,
  index,
  drafts,
  structure,
  levels,
  onChange,
  onRemove,
}: {
  draft: Draft;
  index: number;
  drafts: readonly Draft[];
  structure: Structure;
  levels: { id: string; nameFa: string }[];
  onChange: (draft: Draft) => void;
  onRemove: () => void;
}) {
  const unitOptions = useMemo(
    () => [
      { value: '', label: t('changes.op.pick_unit') },
      ...drafts.flatMap((d) =>
        d.op === 'unit.create' && d.nameFa
          ? [{ value: `${NEW}${d.ref}`, label: t('changes.op.new_item', { name: d.nameFa }) }]
          : [],
      ),
      ...structure.units.map((u) => ({ value: u.id, label: u.name.fa })),
    ],
    [drafts, structure.units],
  );
  const id = (field: string) => `op-${index}-${field}`;
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch } as Draft);
  return (
    <fieldset
      className="flex flex-wrap items-end gap-3 border-2 border-navy p-4"
      data-testid="operation"
    >
      <legend className="px-2 text-label">{t(`changes.op.${draft.op}`)}</legend>
      {(draft.op === 'unit.create' || draft.op === 'unit.update') && (
        <Field
          id={id('name')}
          label={t('changes.op.unit_name')}
          value={draft.nameFa}
          onChange={(e) => set({ nameFa: e.target.value })}
        />
      )}
      {draft.op === 'unit.create' && (
        <Select
          id={id('level')}
          label={t('changes.op.level')}
          value={draft.levelId}
          onChange={(v) => set({ levelId: v })}
          options={[
            { value: '', label: t('changes.op.pick_level') },
            ...levels.map((l) => ({ value: l.id, label: l.nameFa })),
          ]}
        />
      )}
      {(draft.op === 'unit.update' || draft.op === 'unit.close') && (
        <Select
          id={id('unit')}
          label={t('changes.op.unit')}
          value={draft.unitId}
          onChange={(v) => set({ unitId: v })}
          options={unitOptions.filter((o) => !o.value.startsWith(NEW))}
        />
      )}
      {(draft.op === 'unit.create' || draft.op === 'unit.update') && (
        <Select
          id={id('parent')}
          label={t('changes.op.parent')}
          value={draft.parent}
          onChange={(v) => set({ parent: v })}
          options={unitOptions}
        />
      )}
      {(draft.op === 'position.update' || draft.op === 'position.close') && (
        <Field
          id={id('position')}
          label={t('changes.op.position_code')}
          value={draft.position}
          onChange={(e) => set({ position: e.target.value })}
        />
      )}
      {(draft.op === 'position.create' || draft.op === 'position.update') && (
        <>
          <Field
            id={id('title')}
            label={t('changes.op.title')}
            value={draft.titleFa}
            onChange={(e) => set({ titleFa: e.target.value })}
          />
          <Select
            id={id('in-unit')}
            label={t('changes.op.in_unit')}
            value={draft.unit}
            onChange={(v) => set({ unit: v })}
            options={unitOptions}
          />
          <Field
            id={id('reports-to')}
            label={t('changes.op.reports_to')}
            hint={t('changes.op.reports_to.help')}
            value={draft.reportsTo}
            onChange={(e) => set({ reportsTo: e.target.value })}
          />
        </>
      )}
      {draft.op === 'position.create' && (
        <label className="flex h-11 items-center gap-2 text-body-strong">
          <input
            type="checkbox"
            checked={draft.supervisory}
            onChange={(e) => set({ supervisory: e.target.checked })}
            className="size-5 accent-navy"
          />
          {t('changes.op.supervisory')}
        </label>
      )}
      <Button variant="ghost" onClick={onRemove} aria-label={t('changes.op.remove')}>
        <Trash2 size={16} strokeWidth={2.5} aria-hidden="true" />
      </Button>
    </fieldset>
  );
}

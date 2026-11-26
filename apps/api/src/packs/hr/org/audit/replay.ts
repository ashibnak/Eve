import type { PositionVersionState, UnitVersionState } from './state';

/** One org audit row as the replay needs it (in chain order). */
export interface AuditRow {
  seq: bigint;
  action: string;
  entityType: string;
  entityId: string;
  after: unknown;
}

interface Dated<T> {
  from: string;
  to: string | null;
  data: T;
}

export interface Replayed {
  units: Map<string, Dated<UnitVersionState>[]>;
  positions: Map<string, Dated<PositionVersionState>[]>;
  lines: Map<string, Dated<string>[]>;
  assignments: Map<
    string,
    {
      personId: string;
      positionId: string;
      kind: string;
      timeShare: number;
      from: string;
      to: string | null;
    }
  >;
  /** Rows of org entities that carry no replayable state (written before S10, or unknown). */
  gaps: { seq: bigint; action: string; entityId: string; why: string }[];
}

/** The open (or reaching-past-`at`) dated entry that `at` falls in or that is still open. */
function openAt<T>(list: Dated<T>[] | undefined, at: string): Dated<T> | undefined {
  return (
    list?.find((d) => d.from <= at && (d.to === null || d.to > at)) ??
    list?.find((d) => d.to === null)
  );
}

function startFrom<T>(list: Dated<T>[], from: string, data: T): void {
  const current = list.find((d) => d.from < from && (d.to === null || d.to > from));
  if (current) current.to = from;
  list.push({ from, to: null, data });
}

/**
 * Rebuilds the dated org structure from audit rows alone (spec §11). Each row's `after.state`
 * says what it did (see state.ts); rows are applied in the hash chain's order.
 */
export function replay(rows: readonly AuditRow[]): Replayed {
  const out: Replayed = {
    units: new Map(),
    positions: new Map(),
    lines: new Map(),
    assignments: new Map(),
    gaps: [],
  };
  const gap = (row: AuditRow, why: string) =>
    out.gaps.push({ seq: row.seq, action: row.action, entityId: row.entityId, why });

  for (const row of rows) {
    const state = (row.after as { state?: Record<string, unknown> } | null)?.state;
    if (!state) {
      gap(row, 'no state');
      continue;
    }
    if (row.entityType === 'org_assignment') {
      if ('personId' in state) {
        out.assignments.set(row.entityId, {
          personId: String(state.personId),
          positionId: String(state.positionId),
          kind: String(state.kind),
          timeShare: Number(state.timeShare),
          from: String(state.validFrom),
          to: null,
        });
      } else if ('validTo' in state) {
        const a = out.assignments.get(row.entityId);
        if (a) a.to = String(state.validTo);
        else gap(row, 'end of an unknown assignment');
      }
      continue;
    }
    const isUnit = row.entityType === 'org_unit';
    const versions = isUnit ? out.units : out.positions;
    const list = versions.get(row.entityId) ?? [];
    versions.set(row.entityId, list as never);
    if ('validFrom' in state) {
      const from = String(state.validFrom);
      if (state.version) startFrom(list as Dated<unknown>[], from, state.version);
      if (!isUnit && 'reportsToPositionId' in state) {
        const lines = out.lines.get(row.entityId) ?? [];
        out.lines.set(row.entityId, lines);
        const current = lines.find((d) => d.from < from && (d.to === null || d.to > from));
        if (current) current.to = from;
        if (state.reportsToPositionId)
          lines.push({ from, to: null, data: String(state.reportsToPositionId) });
      }
    } else if ('validTo' in state) {
      const to = String(state.validTo);
      const open = openAt(list as Dated<unknown>[], to);
      if (open) open.to = to;
      else gap(row, 'close of an unknown version');
      if (!isUnit) {
        const line = out.lines.get(row.entityId)?.find((d) => d.to === null || d.to > to);
        if (line) line.to = to;
      }
    } else if ('versionFrom' in state) {
      const version = (list as unknown as Dated<Record<string, unknown>>[]).find(
        (d) => d.from === String(state.versionFrom),
      );
      if (version) Object.assign(version.data, state.changes as object);
      else gap(row, 'fix of an unknown version');
    } else {
      gap(row, 'unrecognized state');
    }
  }
  return out;
}

export interface ReplayedStructure {
  units: Map<string, UnitVersionState>;
  positions: Map<string, PositionVersionState & { reportsToPositionId: string | null }>;
  assignments: { id: string; personId: string; positionId: string; kind: string }[];
}

/** The replayed structure on one date. */
export function structureAt(replayed: Replayed, asOf: string): ReplayedStructure {
  const on = <T>(list: Dated<T>[] | undefined) =>
    list?.find((d) => d.from <= asOf && (d.to === null || d.to > asOf));
  const units = new Map<string, UnitVersionState>();
  for (const [id, list] of replayed.units) {
    const v = on(list);
    if (v) units.set(id, v.data);
  }
  const positions = new Map<
    string,
    PositionVersionState & { reportsToPositionId: string | null }
  >();
  for (const [id, list] of replayed.positions) {
    const v = on(list);
    if (v)
      positions.set(id, {
        ...v.data,
        reportsToPositionId: on(replayed.lines.get(id))?.data ?? null,
      });
  }
  const assignments = [...replayed.assignments.entries()]
    .filter(([, a]) => a.from <= asOf && (a.to === null || a.to > asOf))
    .map(([id, a]) => ({ id, personId: a.personId, positionId: a.positionId, kind: a.kind }));
  return { units, positions, assignments };
}

import type { OrgSnapshot } from './index';

const ORDER = ['primary', 'acting', 'temporary_supervision'] as const;

/**
 * Each employed person's effective direct manager on the snapshot's date, in the order of spec §3
 * (the same as `get_manager`): from the position above the person's primary position, its primary
 * incumbent, else its acting, else its temporary supervisor, else the next position up. Positions
 * not in the snapshot (closed) count as vacant; nobody manages themselves. Used to tell who gets a
 * new manager when the structure changes (event `org.manager.changed`).
 */
export function effectiveManagers(snapshot: OrgSnapshot): Map<string, string | null> {
  const employed = new Set(snapshot.employed);
  const open = new Set(snapshot.positions.map((p) => p.id));
  const up = new Map(snapshot.directLines.map((l) => [l.from, l.to]));
  const candidates = new Map<string, string[]>();
  for (const kind of ORDER) {
    const rows = snapshot.assignments
      .filter((a) => a.kind === kind && employed.has(a.personId) && open.has(a.positionId))
      .sort((a, b) => b.timeShare - a.timeShare || (a.personId < b.personId ? -1 : 1));
    for (const a of rows) {
      candidates.set(a.positionId, [...(candidates.get(a.positionId) ?? []), a.personId]);
    }
  }
  const result = new Map<string, string | null>();
  for (const a of snapshot.assignments) {
    if (a.kind !== 'primary' || !employed.has(a.personId)) continue;
    let manager: string | null = null;
    const seen = new Set([a.positionId]);
    for (let p = up.get(a.positionId); p && !seen.has(p); p = up.get(p)) {
      seen.add(p);
      const found = candidates.get(p)?.find((person) => person !== a.personId);
      if (found) {
        manager = found;
        break;
      }
    }
    result.set(a.personId, manager);
  }
  return result;
}

/** People whose effective manager differs between two snapshots (absent = no manager). */
export function managerChanges(
  before: OrgSnapshot,
  after: OrgSnapshot,
): { personId: string; from: string | null; to: string | null }[] {
  const was = effectiveManagers(before);
  const is = effectiveManagers(after);
  const people = [...new Set([...was.keys(), ...is.keys()])].sort();
  return people
    .map((personId) => ({
      personId,
      from: was.get(personId) ?? null,
      to: is.get(personId) ?? null,
    }))
    .filter((c) => c.from !== c.to);
}

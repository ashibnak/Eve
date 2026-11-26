import { orgV1 } from '@eve/contracts';

/** Deterministic UUIDs (version 4 layout) so fixtures validate against the contracts. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export interface Company {
  structure: orgV1.Structure;
  /** The structure a month earlier: one unit and its positions did not exist yet. */
  earlier: orgV1.Structure;
  levels: { id: string; nameFa: string; nameEn: null; rank: number }[];
}

const UNIT_LEVELS = ['مدیریت عامل', 'معاونت', 'مدیریت', 'اداره', 'تیم', 'گروه', 'بخش', 'واحد'];

/**
 * A company of about `positions` positions: each unit has a supervisory head reporting to the
 * parent unit's head and staff under it; every 12th position is vacant, every 40th acting.
 */
export function buildCompany(companyId: string, positions: number, asOf = '2026-11-22'): Company {
  let next = 1000;
  const id = () => uuid(next++);
  const levels = UNIT_LEVELS.map((nameFa, i) => ({
    id: uuid(100 + i),
    nameFa,
    nameEn: null,
    rank: i + 1,
  }));
  const units: orgV1.Structure['units'] = [];
  const list: orgV1.Structure['positions'] = [];
  const position = (
    unitId: string,
    title: string,
    supervisory: boolean,
    reportsTo: string | null,
  ) => {
    const n = list.length + 1;
    const vacant = n > 1 && n % 12 === 0;
    const p = {
      id: id(),
      companyId,
      code: `TST-P${String(n).padStart(5, '0')}`,
      legacyCode: `P${n}`,
      title: { fa: title, en: null },
      unitId,
      jobId: null,
      type: 'approved' as const,
      fte: 1,
      supervisory,
      status: 'active' as const,
      source: 'official' as const,
      occupancy: vacant ? ('vacant' as const) : ('filled' as const),
      reportsToPositionId: reportsTo,
      incumbentCount: vacant ? (n % 40 === 0 ? 1 : 0) : 1,
      asOf: asOf as orgV1.Structure['asOf'],
    };
    list.push(p);
    return p;
  };
  const unit = (level: number, parentUnitId: string | null) => {
    const n = units.length + 1;
    const u = {
      id: id(),
      companyId,
      code: `TST-U${String(n).padStart(4, '0')}`,
      legacyCode: `U${n}`,
      name: { fa: `${UNIT_LEVELS[level]} ${n}`, en: null },
      levelId: levels[level]!.id,
      parentUnitId,
      supervisorPositionId: null as string | null,
      status: 'active' as const,
    };
    units.push(u);
    return u;
  };
  const root = unit(0, null);
  const ceo = position(root.id, 'مدیرعامل', true, null);
  root.supervisorPositionId = ceo.id;
  let frontier = [{ unit: root, head: ceo }];
  for (let level = 1; level < UNIT_LEVELS.length && list.length < positions; level++) {
    const nextFrontier: typeof frontier = [];
    for (const parent of frontier) {
      for (let c = 0; c < (level <= 2 ? 4 : 3) && list.length < positions; c++) {
        const u = unit(level, parent.unit.id);
        const head = position(u.id, `رئیس ${u.name.fa}`, true, parent.head.id);
        u.supervisorPositionId = head.id;
        for (let s = 0; s < (level >= 5 ? 3 : 1) && list.length < positions; s++) {
          position(u.id, `کارشناس ${u.name.fa}`, false, head.id);
        }
        nextFrontier.push({ unit: u, head });
      }
    }
    frontier = nextFrontier;
  }
  let i = 0;
  while (list.length < positions) {
    const leaf = frontier[i++ % frontier.length]!;
    position(leaf.unit.id, `کارشناس ${leaf.unit.name.fa}`, false, leaf.head.id);
  }
  const structure = orgV1.StructureSchema.parse({ companyId, asOf, units, positions: list });
  // A month earlier the last top-level unit (and everything in it) did not exist.
  const lateUnit = units.filter((u) => u.parentUnitId === root.id).at(-1)!;
  const below = new Set([lateUnit.id]);
  for (const u of units) if (u.parentUnitId && below.has(u.parentUnitId)) below.add(u.id);
  const earlier = orgV1.StructureSchema.parse({
    companyId,
    asOf: '2026-10-22',
    units: units.filter((u) => !below.has(u.id)),
    positions: list.filter((p) => !below.has(p.unitId)).map((p) => ({ ...p, asOf: '2026-10-22' })),
  });
  return { structure, earlier, levels };
}

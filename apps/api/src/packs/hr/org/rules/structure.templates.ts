import { z } from 'zod';
import { defineRuleTemplate } from '../../../../platform/rules/rule-template';
import {
  Id,
  LineSchema,
  NoParams,
  UnitSchema,
  type Violation,
  ViolationsSchema,
  nodesOnCycles,
  sorted,
} from './common';

/** R1 (blocking): every unit has exactly one parent, except one company root; no cycles. */
export const UnitSingleParentV1 = defineRuleTemplate({
  id: 'org.unit_single_parent',
  version: 1,
  description: {
    fa: 'هر واحد دقیقاً یک والد دارد (جز ریشهٔ شرکت) و چرخه ندارد',
    en: 'Every unit has exactly one parent (except the company root) and no cycle',
  },
  params: NoParams,
  defaultParams: {},
  input: z.object({ units: z.array(UnitSchema) }),
  output: ViolationsSchema,
  evaluate({ units }) {
    const ids = new Set(units.map((u) => u.id));
    const violations: Violation[] = [];
    const roots = units.filter((u) => u.parentId === null);
    if (roots.length > 1) {
      for (const r of roots) {
        violations.push({
          subject: { type: 'unit', id: r.id },
          key: 'extra_root',
          detail: { roots: roots.map((x) => x.id).sort() },
        });
      }
    }
    for (const u of units) {
      if (u.parentId !== null && !ids.has(u.parentId)) {
        violations.push({
          subject: { type: 'unit', id: u.id },
          key: 'unknown_parent',
          detail: { parentId: u.parentId },
        });
      }
    }
    const cycle = nodesOnCycles(new Map(units.map((u) => [u.id, u.parentId])));
    for (const id of cycle) {
      violations.push({ subject: { type: 'unit', id }, key: 'cycle', detail: {} });
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'one root, a proper tree',
      input: {
        units: [
          { id: 'u1', parentId: null },
          { id: 'u2', parentId: 'u1' },
          { id: 'u3', parentId: 'u2' },
        ],
      },
      expect: { violations: [] },
    },
    {
      name: 'two roots and a cycle',
      input: {
        units: [
          { id: 'u1', parentId: null },
          { id: 'u2', parentId: null },
          { id: 'u3', parentId: 'u4' },
          { id: 'u4', parentId: 'u3' },
          { id: 'u5', parentId: 'u3' },
        ],
      },
      expect: {
        violations: [
          {
            subject: { type: 'unit', id: 'u1' },
            key: 'extra_root',
            detail: { roots: ['u1', 'u2'] },
          },
          {
            subject: { type: 'unit', id: 'u2' },
            key: 'extra_root',
            detail: { roots: ['u1', 'u2'] },
          },
          { subject: { type: 'unit', id: 'u3' }, key: 'cycle', detail: {} },
          { subject: { type: 'unit', id: 'u4' }, key: 'cycle', detail: {} },
        ],
      },
    },
    {
      name: 'parent outside the company',
      input: {
        units: [
          { id: 'u1', parentId: null },
          { id: 'u2', parentId: 'x9' },
        ],
      },
      expect: {
        violations: [
          {
            subject: { type: 'unit', id: 'u2' },
            key: 'unknown_parent',
            detail: { parentId: 'x9' },
          },
        ],
      },
    },
  ],
});

/** R2 (blocking): every position has exactly one direct line, except one top position; no cycles. */
export const PositionSingleDirectLineV1 = defineRuleTemplate({
  id: 'org.position_single_direct_line',
  version: 1,
  description: {
    fa: 'هر پست دقیقاً یک خط گزارش مستقیم دارد (جز بالاترین پست) و چرخه ندارد',
    en: 'Every position has exactly one direct reporting line (except the top) and no cycle',
  },
  params: NoParams,
  defaultParams: {},
  input: z.object({ positions: z.array(Id), directLines: z.array(LineSchema) }),
  output: ViolationsSchema,
  evaluate({ positions, directLines }) {
    const ids = new Set(positions);
    const violations: Violation[] = [];
    const up = new Map<string, string[]>();
    for (const line of directLines) up.set(line.from, [...(up.get(line.from) ?? []), line.to]);
    const tops = positions.filter((p) => !up.has(p));
    if (tops.length > 1) {
      for (const p of tops) {
        violations.push({
          subject: { type: 'position', id: p },
          key: 'extra_top',
          detail: { tops: [...tops].sort() },
        });
      }
    }
    for (const [from, targets] of up) {
      if (targets.length > 1) {
        violations.push({
          subject: { type: 'position', id: from },
          key: 'two_direct_lines',
          detail: { to: [...targets].sort() },
        });
      }
      for (const to of targets) {
        if (!ids.has(to)) {
          violations.push({
            subject: { type: 'position', id: from },
            key: 'unknown_target',
            detail: { to },
          });
        }
      }
    }
    const parent = new Map<string, string | null>(
      positions.map((p) => [p, up.get(p)?.[0] ?? null]),
    );
    for (const id of nodesOnCycles(parent)) {
      violations.push({ subject: { type: 'position', id }, key: 'cycle', detail: {} });
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'one top, one line each',
      input: {
        positions: ['p1', 'p2', 'p3'],
        directLines: [
          { from: 'p2', to: 'p1' },
          { from: 'p3', to: 'p1' },
        ],
      },
      expect: { violations: [] },
    },
    {
      name: 'two tops, two lines from one position, a cycle',
      input: {
        positions: ['p1', 'p2', 'p3', 'p4', 'p5'],
        directLines: [
          { from: 'p3', to: 'p1' },
          { from: 'p3', to: 'p2' },
          { from: 'p4', to: 'p5' },
          { from: 'p5', to: 'p4' },
        ],
      },
      expect: {
        violations: [
          {
            subject: { type: 'position', id: 'p1' },
            key: 'extra_top',
            detail: { tops: ['p1', 'p2'] },
          },
          {
            subject: { type: 'position', id: 'p2' },
            key: 'extra_top',
            detail: { tops: ['p1', 'p2'] },
          },
          {
            subject: { type: 'position', id: 'p3' },
            key: 'two_direct_lines',
            detail: { to: ['p1', 'p2'] },
          },
          { subject: { type: 'position', id: 'p4' }, key: 'cycle', detail: {} },
          { subject: { type: 'position', id: 'p5' }, key: 'cycle', detail: {} },
        ],
      },
    },
  ],
});

/** R5 (warning): a position's direct manager sits in the same unit or a unit above it. */
export const ManagerInUnitLineV1 = defineRuleTemplate({
  id: 'org.manager_in_unit_line',
  version: 1,
  description: {
    fa: 'مدیر مستقیم پست در همان واحد یا واحدهای بالادست است',
    en: "A position's direct manager is in the same unit or a unit above it",
  },
  params: NoParams,
  defaultParams: {},
  input: z.object({
    units: z.array(UnitSchema),
    positions: z.array(z.object({ id: Id, unitId: Id })),
    directLines: z.array(LineSchema),
  }),
  output: ViolationsSchema,
  evaluate({ units, positions, directLines }) {
    const parent = new Map(units.map((u) => [u.id, u.parentId]));
    const unitOf = new Map(positions.map((p) => [p.id, p.unitId]));
    const inLine = (unit: string, candidate: string) => {
      const seen = new Set<string>();
      for (let u: string | null | undefined = unit; u && !seen.has(u); u = parent.get(u)) {
        if (u === candidate) return true;
        seen.add(u);
      }
      return false;
    };
    const violations: Violation[] = [];
    for (const line of directLines) {
      const own = unitOf.get(line.from);
      const managers = unitOf.get(line.to);
      if (!own || !managers || inLine(own, managers)) continue;
      violations.push({
        subject: { type: 'position', id: line.from },
        key: 'manager_outside_unit_line',
        detail: { managerPositionId: line.to, unitId: own, managerUnitId: managers },
      });
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'manager in the same unit and in the parent unit',
      input: {
        units: [
          { id: 'u1', parentId: null },
          { id: 'u2', parentId: 'u1' },
        ],
        positions: [
          { id: 'p1', unitId: 'u1' },
          { id: 'p2', unitId: 'u2' },
          { id: 'p3', unitId: 'u2' },
        ],
        directLines: [
          { from: 'p2', to: 'p1' },
          { from: 'p3', to: 'p2' },
        ],
      },
      expect: { violations: [] },
    },
    {
      name: 'manager in a sibling unit',
      input: {
        units: [
          { id: 'u1', parentId: null },
          { id: 'u2', parentId: 'u1' },
          { id: 'u3', parentId: 'u1' },
        ],
        positions: [
          { id: 'p2', unitId: 'u2' },
          { id: 'p3', unitId: 'u3' },
        ],
        directLines: [{ from: 'p3', to: 'p2' }],
      },
      expect: {
        violations: [
          {
            subject: { type: 'position', id: 'p3' },
            key: 'manager_outside_unit_line',
            detail: { managerPositionId: 'p2', unitId: 'u3', managerUnitId: 'u2' },
          },
        ],
      },
    },
  ],
});

/** R6 (warning): every unit has a supervisor position reporting to the parent unit's supervisor. */
export const UnitSupervisorChainV1 = defineRuleTemplate({
  id: 'org.unit_supervisor_chain',
  version: 1,
  description: {
    fa: 'هر واحد یک پست سرپرست دارد که به سرپرست واحد والد گزارش می‌دهد',
    en: "Every unit has a supervisor position that reports to the parent unit's supervisor",
  },
  params: NoParams,
  defaultParams: {},
  input: z.object({
    units: z.array(UnitSchema.extend({ supervisorPositionId: Id.nullable() })),
    directLines: z.array(LineSchema),
  }),
  output: ViolationsSchema,
  evaluate({ units, directLines }) {
    const byId = new Map(units.map((u) => [u.id, u]));
    const up = new Map(directLines.map((l) => [l.from, l.to]));
    const violations: Violation[] = [];
    for (const unit of units) {
      if (!unit.supervisorPositionId) {
        violations.push({
          subject: { type: 'unit', id: unit.id },
          key: 'no_supervisor',
          detail: {},
        });
        continue;
      }
      const parentSupervisor = unit.parentId ? byId.get(unit.parentId)?.supervisorPositionId : null;
      if (!parentSupervisor) continue;
      const reportsTo = up.get(unit.supervisorPositionId) ?? null;
      if (reportsTo !== parentSupervisor) {
        violations.push({
          subject: { type: 'unit', id: unit.id },
          key: 'supervisor_not_under_parent_supervisor',
          detail: {
            supervisorPositionId: unit.supervisorPositionId,
            expected: parentSupervisor,
            actual: reportsTo,
          },
        });
      }
    }
    return sorted(violations);
  },
  cases: [
    {
      name: 'supervisors chained like the units',
      input: {
        units: [
          { id: 'u1', parentId: null, supervisorPositionId: 'p1' },
          { id: 'u2', parentId: 'u1', supervisorPositionId: 'p2' },
        ],
        directLines: [{ from: 'p2', to: 'p1' }],
      },
      expect: { violations: [] },
    },
    {
      name: 'a unit without supervisor and one whose supervisor reports elsewhere',
      input: {
        units: [
          { id: 'u1', parentId: null, supervisorPositionId: 'p1' },
          { id: 'u2', parentId: 'u1', supervisorPositionId: null },
          { id: 'u3', parentId: 'u1', supervisorPositionId: 'p3' },
        ],
        directLines: [{ from: 'p3', to: 'p9' }],
      },
      expect: {
        violations: [
          { subject: { type: 'unit', id: 'u2' }, key: 'no_supervisor', detail: {} },
          {
            subject: { type: 'unit', id: 'u3' },
            key: 'supervisor_not_under_parent_supervisor',
            detail: { supervisorPositionId: 'p3', expected: 'p1', actual: 'p9' },
          },
        ],
      },
    },
  ],
});

/** R14 (info): no more than `layers` levels from the top position to the lowest one. */
export const MaxLayersV1 = defineRuleTemplate({
  id: 'org.max_layers',
  version: 1,
  description: {
    fa: 'بیش از ۷ لایه از مدیرعامل تا پایین‌ترین پست',
    en: 'More than 7 layers from the chief executive to the lowest position',
  },
  params: z.object({ layers: z.number().int().min(1) }),
  defaultParams: { layers: 7 },
  input: z.object({ companyId: Id, positions: z.array(Id), directLines: z.array(LineSchema) }),
  output: ViolationsSchema,
  evaluate({ companyId, positions, directLines }, { layers }) {
    const below = new Map<string, string[]>();
    const hasManager = new Set<string>();
    for (const l of directLines) {
      below.set(l.to, [...(below.get(l.to) ?? []), l.from]);
      hasManager.add(l.from);
    }
    // Breadth first from every top position; the deepest chain (ties: smallest ids) is the evidence.
    let deepest: string[] = [];
    const seen = new Set<string>();
    let frontier: string[][] = positions
      .filter((p) => !hasManager.has(p))
      .sort()
      .map((p) => [p]);
    for (const path of frontier) seen.add(path[0]!);
    while (frontier.length > 0) {
      deepest = frontier[0]!;
      const next: string[][] = [];
      for (const path of frontier) {
        for (const child of [...(below.get(path[path.length - 1]!) ?? [])].sort()) {
          if (seen.has(child)) continue;
          seen.add(child);
          next.push([...path, child]);
        }
      }
      frontier = next;
    }
    if (deepest.length <= layers) return { violations: [] };
    return {
      violations: [
        {
          subject: { type: 'company' as const, id: companyId },
          key: 'too_many_layers',
          detail: { layers: deepest.length, chain: deepest },
        },
      ],
    };
  },
  cases: [
    {
      name: 'three layers within a limit of three',
      params: { layers: 3 },
      input: {
        companyId: 'c1',
        positions: ['p1', 'p2', 'p3'],
        directLines: [
          { from: 'p2', to: 'p1' },
          { from: 'p3', to: 'p2' },
        ],
      },
      expect: { violations: [] },
    },
    {
      name: 'four layers over a limit of three',
      params: { layers: 3 },
      input: {
        companyId: 'c1',
        positions: ['p1', 'p2', 'p3', 'p4', 'p5'],
        directLines: [
          { from: 'p2', to: 'p1' },
          { from: 'p3', to: 'p2' },
          { from: 'p4', to: 'p3' },
          { from: 'p5', to: 'p1' },
        ],
      },
      expect: {
        violations: [
          {
            subject: { type: 'company', id: 'c1' },
            key: 'too_many_layers',
            detail: { layers: 4, chain: ['p1', 'p2', 'p3', 'p4'] },
          },
        ],
      },
    },
  ],
});

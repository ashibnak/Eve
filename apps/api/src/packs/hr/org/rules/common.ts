import { z } from 'zod';

/**
 * Shared shapes of the org rule templates (spec §5). A template sees a compact slice of one
 * company on one date and lists what violates it; it never reads the database or the clock.
 * Ids are plain strings, so worked examples stay readable ('u1', 'p2').
 */

export const Id = z.string().min(1);
export const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const SubjectSchema = z.object({
  type: z.enum(['company', 'unit', 'position', 'person', 'change']),
  id: Id,
});

/** One violation: what (subject), which aspect (key: part of the fingerprint), and evidence. */
export const ViolationSchema = z.object({
  subject: SubjectSchema,
  key: z.string().min(1),
  detail: z.record(z.string(), z.unknown()),
});
export type Violation = z.infer<typeof ViolationSchema>;

export const ViolationsSchema = z.object({ violations: z.array(ViolationSchema) });
export type Violations = z.infer<typeof ViolationsSchema>;

export const NoParams = z.object({}).strict();

export const UnitSchema = z.object({ id: Id, parentId: Id.nullable() });
export const LineSchema = z.object({ from: Id, to: Id });

/** Whole days from `from` to `to` (both YYYY-MM-DD); pure date arithmetic, no time zone. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Violations sorted by subject and key, so output never depends on input order. */
export function sorted(violations: Violation[]): Violations {
  const order = (v: Violation) => `${v.subject.type}|${v.subject.id}|${v.key}`;
  return {
    violations: [...violations].sort((a, b) =>
      order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0,
    ),
  };
}

/**
 * Nodes on a cycle of a "points to one parent" graph (unit → parent, position → position above).
 * Nodes that merely lead into a cycle are not on it.
 */
export function nodesOnCycles(parentOf: ReadonlyMap<string, string | null>): Set<string> {
  const onCycle = new Set<string>();
  const done = new Set<string>();
  for (const start of parentOf.keys()) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const index = new Map<string, number>();
    let node: string | null | undefined = start;
    while (node && parentOf.has(node) && !done.has(node) && !index.has(node)) {
      index.set(node, path.length);
      path.push(node);
      node = parentOf.get(node);
    }
    if (node && index.has(node)) for (const n of path.slice(index.get(node))) onCycle.add(n);
    for (const n of path) done.add(n);
  }
  return onCycle;
}

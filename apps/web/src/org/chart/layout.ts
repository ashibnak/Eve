/**
 * Tidy-tree layout of the reporting lines (no library): each visible position gets a slot; a
 * manager sits centred above its visible reports; the first report is on the inline-start side
 * (right in Persian). Deterministic: the same structure and expansion give the same picture.
 */
export interface TreeInput {
  id: string;
  reportsTo: string | null;
  /** Sort key among siblings (supervisory positions first, then code). */
  order: string;
}

export interface LaidOut {
  id: string;
  depth: number;
  x: number;
  y: number;
  childCount: number;
  expanded: boolean;
}

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 88;
const GAP_X = 24;
const GAP_Y = 64;

export interface Tree {
  roots: string[];
  children: Map<string, string[]>;
  depth: Map<string, number>;
}

/** Parent → children, roots and depths; positions reporting to a missing position are roots. */
export function buildTree(input: readonly TreeInput[]): Tree {
  const ids = new Set(input.map((p) => p.id));
  const order = new Map(input.map((p) => [p.id, p.order]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const p of input) {
    if (p.reportsTo && ids.has(p.reportsTo) && p.reportsTo !== p.id) {
      const list = children.get(p.reportsTo);
      if (list) list.push(p.id);
      else children.set(p.reportsTo, [p.id]);
    } else {
      roots.push(p.id);
    }
  }
  const byOrder = (a: string, b: string) => {
    const x = order.get(a)!;
    const y = order.get(b)!;
    return x < y ? -1 : x > y ? 1 : 0;
  };
  roots.sort(byOrder);
  for (const list of children.values()) list.sort(byOrder);
  const depth = new Map<string, number>();
  const queue: [string, number][] = roots.map((id) => [id, 0]);
  for (let i = 0; i < queue.length; i++) {
    const [id, d] = queue[i]!;
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const child of children.get(id) ?? []) queue.push([child, d + 1]);
  }
  return { roots, children, depth };
}

/** Positions open by default: those above `levels` levels (3 levels visible). */
export function defaultExpanded(tree: Tree, levels = 3): Set<string> {
  const open = new Set<string>();
  for (const [id, d] of tree.depth) if (d < levels - 1 && tree.children.has(id)) open.add(id);
  return open;
}

export function layout(
  tree: Tree,
  expanded: ReadonlySet<string>,
  direction: 'rtl' | 'ltr' = 'rtl',
): LaidOut[] {
  const out: LaidOut[] = [];
  let slot = 0;
  const seen = new Set<string>();
  const place = (id: string, depth: number): number => {
    seen.add(id);
    const kids = (tree.children.get(id) ?? []).filter((k) => !seen.has(k));
    const open = expanded.has(id) && kids.length > 0;
    let x: number;
    const index = out.length;
    out.push({
      id,
      depth,
      x: 0,
      y: depth * (NODE_HEIGHT + GAP_Y),
      childCount: kids.length,
      expanded: open,
    });
    if (open) {
      const xs = kids.map((k) => place(k, depth + 1));
      x = (xs[0]! + xs[xs.length - 1]!) / 2;
    } else {
      x = slot * (NODE_WIDTH + GAP_X);
      slot += 1;
    }
    out[index]!.x = x;
    return x;
  };
  for (const root of tree.roots) place(root, 0);
  if (direction === 'rtl') for (const n of out) n.x = -n.x;
  return out;
}

/** Every position on the way from a root down to `id` (to open the path to a search hit). */
export function pathTo(parentOf: ReadonlyMap<string, string | null>, id: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  for (let p = parentOf.get(id) ?? null; p && !seen.has(p); p = parentOf.get(p) ?? null) {
    seen.add(p);
    path.push(p);
  }
  return path;
}

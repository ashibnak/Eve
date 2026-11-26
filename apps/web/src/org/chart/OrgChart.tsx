import {
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '../../i18n/t';
import { formatNumber } from '../../lib/format';
import { Badge } from '../../ui/kit';
import type { Structure, StructurePosition } from '../api';
import { buildTree, defaultExpanded, layout, NODE_HEIGHT, NODE_WIDTH, pathTo } from './layout';

interface PositionNodeData extends Record<string, unknown> {
  position: StructurePosition;
  unitName: string;
  findings: number;
  childCount: number;
  expanded: boolean;
  highlighted: boolean;
  changed: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}

/** One position: title, unit, and marks for vacant, acting and findings (never colour alone). */
const PositionNode = memo(function PositionNode({ data }: NodeProps<Node<PositionNodeData>>) {
  const p = data.position;
  const acting = p.occupancy === 'vacant' && p.incumbentCount > 0;
  return (
    <div
      data-testid="chart-node"
      data-position-id={p.id}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`flex flex-col justify-between border-2 border-navy px-3 py-2 text-navy ${
        data.highlighted
          ? 'bg-surface-cream shadow-hard'
          : data.changed
            ? 'bg-steel-wash'
            : 'bg-surface'
      }`}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <button
        type="button"
        onClick={() => data.onOpen(p.id)}
        className="truncate text-start text-body-strong hover:underline"
        title={p.title.fa}
      >
        {p.title.fa}
      </button>
      <p className="truncate text-meta text-ink-muted">{data.unitName}</p>
      <div className="flex items-center gap-1">
        {p.occupancy === 'vacant' && !acting && (
          <Badge variant="wait">{t('org.chart.vacant')}</Badge>
        )}
        {acting && <Badge variant="info">{t('org.chart.acting')}</Badge>}
        {data.findings > 0 && <Badge variant="warn">{formatNumber(data.findings)}</Badge>}
        {data.childCount > 0 && (
          <button
            type="button"
            onClick={() => data.onToggle(p.id)}
            aria-expanded={data.expanded}
            aria-label={t(data.expanded ? 'org.chart.collapse' : 'org.chart.expand', {
              count: formatNumber(data.childCount),
            })}
            className="ms-auto inline-flex items-center gap-1 border-2 border-navy px-1 text-caption hover:bg-surface-cream"
          >
            {formatNumber(data.childCount)}
            {data.expanded ? (
              <ChevronUp size={14} strokeWidth={2.5} />
            ) : (
              <ChevronDown size={14} strokeWidth={2.5} />
            )}
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  );
});

const nodeTypes = { position: PositionNode };

export interface OrgChartProps {
  structure: Structure;
  findingsBySubject?: ReadonlyMap<string, number> | undefined;
  /** Positions to mark as changed (before/after view of a change request). */
  changed?: ReadonlySet<string> | undefined;
  onOpen: (positionId: string) => void;
  /** Positions open on load: the top levels by default. */
  levels?: number;
  search?: string;
  label: string;
}

function Chart({
  structure,
  findingsBySubject,
  changed,
  onOpen,
  levels = 3,
  search = '',
  label,
}: OrgChartProps) {
  const unitName = useMemo(
    () => new Map(structure.units.map((u) => [u.id, u.name.fa])),
    [structure],
  );
  const byId = useMemo(() => new Map(structure.positions.map((p) => [p.id, p])), [structure]);
  const parentOf = useMemo(
    () => new Map(structure.positions.map((p) => [p.id, p.reportsToPositionId])),
    [structure],
  );
  const tree = useMemo(
    () =>
      buildTree(
        structure.positions.map((p) => ({
          id: p.id,
          reportsTo: p.reportsToPositionId,
          order: `${p.supervisory ? 0 : 1}|${p.code}`,
        })),
      ),
    [structure],
  );
  // Expansion belongs to one tree: a new structure (another date or company) starts fresh.
  const [state, setState] = useState(() => ({ tree, levels, open: defaultExpanded(tree, levels) }));
  if (state.tree !== tree || state.levels !== levels) {
    setState({ tree, levels, open: defaultExpanded(tree, levels) });
  }
  const [ready, setReady] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance<Node<PositionNodeData>> | null>(null);

  const needle = search.trim();
  const hit = useMemo(
    () =>
      needle
        ? structure.positions.find((p) => p.title.fa.includes(needle) || p.code.includes(needle))
        : undefined,
    [needle, structure],
  );
  // The path down to a search hit is open, on top of what the user opened.
  const expanded = useMemo(
    () => (hit ? new Set([...state.open, ...pathTo(parentOf, hit.id)]) : state.open),
    [state.open, hit, parentOf],
  );
  const setExpanded = useCallback(
    (update: (open: Set<string>) => Set<string>) =>
      setState((s) => ({ ...s, open: update(new Set(s.open)) })),
    [],
  );

  const toggle = useCallback(
    (id: string) => {
      setExpanded((open) => {
        if (open.has(id)) open.delete(id);
        else open.add(id);
        return open;
      });
    },
    [setExpanded],
  );

  const { nodes, edges } = useMemo(() => {
    const placed = layout(tree, expanded, document.documentElement.dir === 'ltr' ? 'ltr' : 'rtl');
    const visible = new Set(placed.map((n) => n.id));
    const nodes: Node<PositionNodeData>[] = placed.map((n) => ({
      id: n.id,
      type: 'position',
      position: { x: n.x, y: n.y },
      draggable: false,
      connectable: false,
      data: {
        position: byId.get(n.id)!,
        unitName: unitName.get(byId.get(n.id)!.unitId) ?? '',
        findings: findingsBySubject?.get(n.id) ?? 0,
        childCount: n.childCount,
        expanded: n.expanded,
        highlighted: hit?.id === n.id,
        changed: changed?.has(n.id) ?? false,
        onToggle: toggle,
        onOpen,
      },
    }));
    const edges: Edge[] = placed.flatMap((n) => {
      const parent = parentOf.get(n.id);
      return parent && visible.has(parent)
        ? [
            {
              id: `${parent}-${n.id}`,
              source: parent,
              target: n.id,
              type: 'smoothstep',
              style: { stroke: 'var(--navy)', strokeWidth: 2 },
            },
          ]
        : [];
    });
    return { nodes, edges };
  }, [tree, expanded, byId, unitName, findingsBySubject, changed, hit, toggle, onOpen, parentOf]);

  useEffect(() => {
    if (flow && hit) void flow.fitView({ nodes: [{ id: hit.id }], duration: 300, maxZoom: 1 });
  }, [flow, hit]);

  return (
    <div
      role="region"
      aria-label={label}
      data-testid="org-chart"
      data-ready={ready ? 'true' : 'false'}
      data-nodes={nodes.length}
      className="org-chart h-[640px] border-2 border-navy bg-surface"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onlyRenderVisibleElements
        nodesDraggable={false}
        nodesConnectable={false}
        minZoom={0.05}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          setFlow(instance);
          // Two frames: the first paint of the nodes, then interactive.
          requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
        }}
      />
    </div>
  );
}

export function OrgChart(props: OrgChartProps) {
  return (
    <ReactFlowProvider>
      <Chart {...props} />
    </ReactFlowProvider>
  );
}

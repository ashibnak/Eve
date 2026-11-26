import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useRouter } from '../app/router';
import { useApi, useWorkspace } from '../app/workspace';
import { t } from '../i18n/t';
import { formatNumber } from '../lib/format';
import {
  orgPaths,
  positionTypeLabel,
  statusLabel,
  type Structure,
  type StructurePosition,
} from '../org/api';
import { type Column, DataTable } from '../ui/DataTable';
import { Field } from '../ui/Field';
import { Badge, ErrorNote, Loading, PageHeader, Select, StatTile, Stats } from '../ui/kit';
import { useFindingCounts } from './ChartPage';

const FILTERS = ['all', 'vacant', 'no_job', 'proposed', 'frozen', 'findings'] as const;
type Filter = (typeof FILTERS)[number];

/** All positions on the date asked, filtered and exported (spec §9 positions table). */
export function PositionsPage() {
  const { company, asOf } = useWorkspace();
  const { navigate } = useRouter();
  const structure = useApi<Structure>(company ? orgPaths.structure(company.companyId, asOf) : null);
  const findings = useFindingCounts(company?.companyId);
  const [filter, setFilter] = useState<Filter>('all');
  const [unit, setUnit] = useState('');
  const [text, setText] = useState('');

  const units = useMemo(
    () => new Map(structure.data?.units.map((u) => [u.id, u]) ?? []),
    [structure.data],
  );
  const rows = useMemo(() => {
    const all = structure.data?.positions ?? [];
    const needle = text.trim();
    return all.filter(
      (p) =>
        (filter === 'all' ||
          (filter === 'vacant' && p.occupancy === 'vacant') ||
          (filter === 'no_job' && p.jobId === null) ||
          (filter === 'proposed' && p.source === 'proposed') ||
          (filter === 'frozen' && p.status === 'frozen') ||
          (filter === 'findings' && (findings.get(p.id) ?? 0) > 0)) &&
        (!unit || p.unitId === unit) &&
        (!needle ||
          p.title.fa.includes(needle) ||
          p.code.includes(needle) ||
          (p.legacyCode ?? '').includes(needle)),
    );
  }, [structure.data, filter, unit, text, findings]);

  const columns: Column<StructurePosition>[] = [
    {
      key: 'code',
      header: t('positions.col.code'),
      cell: (p) => p.code,
      sort: (p) => p.code,
      numeric: true,
    },
    {
      key: 'title',
      header: t('positions.col.title'),
      cell: (p) => p.title.fa,
      sort: (p) => p.title.fa,
    },
    {
      key: 'unit',
      header: t('positions.col.unit'),
      cell: (p) => units.get(p.unitId)?.name.fa ?? '',
      sort: (p) => units.get(p.unitId)?.name.fa ?? '',
    },
    {
      key: 'type',
      header: t('positions.col.type'),
      cell: (p) => positionTypeLabel(p.type),
    },
    {
      key: 'occupancy',
      header: t('positions.col.occupancy'),
      cell: (p) =>
        p.occupancy === 'vacant' ? (
          <Badge variant="wait">{t('org.chart.vacant')}</Badge>
        ) : (
          <Badge>{t('positions.filled')}</Badge>
        ),
      sort: (p) => p.occupancy,
    },
    {
      key: 'status',
      header: t('positions.col.status'),
      cell: (p) => statusLabel(p.status),
    },
    {
      key: 'findings',
      header: t('positions.col.findings'),
      cell: (p) =>
        (findings.get(p.id) ?? 0) > 0 ? (
          <Badge variant="warn">{formatNumber(findings.get(p.id)!)}</Badge>
        ) : (
          ''
        ),
      sort: (p) => findings.get(p.id) ?? 0,
      numeric: true,
    },
  ];

  const all = structure.data?.positions ?? [];
  const vacant = all.filter((p) => p.occupancy === 'vacant').length;
  const proposed = all.filter((p) => p.source === 'proposed').length;
  const withFindings = all.filter((p) => (findings.get(p.id) ?? 0) > 0).length;

  return (
    <section>
      <PageHeader
        eyebrow={company?.nameFa ?? ''}
        title={t('positions.title')}
        status={t('positions.status', {
          shown: formatNumber(rows.length),
          total: formatNumber(all.length),
        })}
        tools={
          company && (
            <a
              href={orgPaths.export(company.companyId, asOf)}
              download
              className="inline-flex h-11 items-center gap-2 border-2 border-navy bg-red px-4 text-body-strong font-black text-on-red shadow-hard-sm hover:bg-red-dark"
            >
              <Download size={16} strokeWidth={2.5} aria-hidden="true" />
              {t('positions.export')}
            </a>
          )
        }
      />
      <Stats>
        <StatTile label={t('positions.stat.total')} value={formatNumber(all.length)} />
        <StatTile label={t('positions.stat.vacant')} value={formatNumber(vacant)} />
        <StatTile label={t('positions.stat.proposed')} value={formatNumber(proposed)} />
        <StatTile label={t('positions.stat.findings')} value={formatNumber(withFindings)} />
      </Stats>
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Select
          id="filter"
          label={t('positions.filter')}
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          options={FILTERS.map((f) => ({
            value: f,
            label: t(`positions.filter.${f}`),
          }))}
        />
        <Select
          id="unit"
          label={t('positions.unit')}
          value={unit}
          onChange={setUnit}
          options={[
            { value: '', label: t('positions.unit.all') },
            ...[...units.values()].map((u) => ({ value: u.id, label: u.name.fa })),
          ]}
        />
        <Field
          id="positions-search"
          label={t('positions.search')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      {structure.loading && <Loading />}
      {structure.error !== null && <ErrorNote error={structure.error} />}
      {structure.data && (
        <DataTable<StructurePosition>
          label={t('positions.title')}
          rows={rows}
          rowKey={(p) => p.id}
          onRowClick={(p) => navigate(`/positions/${p.id}`)}
          empty={t('positions.empty')}
          columns={columns}
        />
      )}
    </section>
  );
}

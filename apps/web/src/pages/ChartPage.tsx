import type { orgV1 } from '@eve/contracts';
import { Printer } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from '../app/router';
import { useApi, useWorkspace } from '../app/workspace';
import { t } from '../i18n/t';
import { formatDate, formatNumber } from '../lib/format';
import { orgPaths, type Structure } from '../org/api';
import { OrgChart } from '../org/chart/OrgChart';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ErrorNote, Loading, PageHeader } from '../ui/kit';

/** Counts of open findings per subject, for the marks on the chart and in the table. */
export function useFindingCounts(companyId: string | undefined): ReadonlyMap<string, number> {
  const findings = useApi<orgV1.FindingView[]>(
    companyId ? orgPaths.findings(companyId, '&limit=5000') : null,
  );
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of findings.data ?? [])
      counts.set(f.subject.id, (counts.get(f.subject.id) ?? 0) + 1);
    return counts;
  }, [findings.data]);
}

/** The organization chart on the date asked (spec §9): expandable, searchable, printable. */
export function ChartPage() {
  const { company, asOf } = useWorkspace();
  const { navigate, location } = useRouter();
  const [search, setSearch] = useState('');
  // How many levels open on load (default 3); `?levels=99` opens everything.
  const levels = Math.max(1, Number(location.query.get('levels')) || 3);
  const structure = useApi<Structure>(company ? orgPaths.structure(company.companyId, asOf) : null);
  const findings = useFindingCounts(company?.companyId);
  const open = useCallback((id: string) => navigate(`/positions/${id}`), [navigate]);

  return (
    <section>
      <PageHeader
        eyebrow={company?.nameFa ?? ''}
        title={t('chart.title')}
        status={
          structure.data
            ? t('chart.status', {
                positions: formatNumber(structure.data.positions.length),
                units: formatNumber(structure.data.units.length),
                date: formatDate(asOf),
              })
            : undefined
        }
        tools={
          <>
            <Field
              id="chart-search"
              label={t('chart.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button onClick={() => window.print()}>
              <Printer size={16} strokeWidth={2.5} aria-hidden="true" />
              {t('chart.print')}
            </Button>
          </>
        }
      />
      {structure.loading && <Loading />}
      {structure.error !== null && <ErrorNote error={structure.error} />}
      {structure.data && (
        <OrgChart
          structure={structure.data}
          findingsBySubject={findings}
          onOpen={open}
          levels={levels}
          search={search}
          label={t('chart.title')}
        />
      )}
    </section>
  );
}

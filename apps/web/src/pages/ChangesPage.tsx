import type { orgV1 } from '@eve/contracts';
import { Link, useRouter } from '../app/router';
import { useApi, useWorkspace } from '../app/workspace';
import { t } from '../i18n/t';
import { formatDate, formatNumber } from '../lib/format';
import { orgPaths } from '../org/api';
import { Badge, ErrorNote, InboxItem, InboxList, Loading, PageHeader } from '../ui/kit';

/** Structure change requests of the company (spec §8, §9). */
export function ChangesPage() {
  const { company } = useWorkspace();
  const { navigate } = useRouter();
  const requests = useApi<orgV1.ChangeRequestView[]>(
    company ? orgPaths.changeRequests(company.companyId) : null,
  );
  return (
    <section>
      <PageHeader
        eyebrow={company?.nameFa ?? ''}
        title={t('changes.title')}
        status={
          requests.data
            ? t('changes.status', { count: formatNumber(requests.data.length) })
            : undefined
        }
        tools={
          company?.can.requestChange && (
            <Link
              to="/changes/new"
              className="inline-flex h-11 items-center border-2 border-navy bg-red px-4 text-body-strong font-black text-on-red shadow-hard-sm hover:bg-red-dark"
            >
              {t('changes.new')}
            </Link>
          )
        }
      />
      {requests.loading && <Loading />}
      {requests.error !== null && <ErrorNote error={requests.error} />}
      {requests.data && requests.data.length === 0 && (
        <p className="text-body text-ink-muted">{t('changes.empty')}</p>
      )}
      {requests.data && requests.data.length > 0 && (
        <InboxList label={t('changes.title')}>
          {requests.data.map((r) => (
            <InboxItem
              key={r.id}
              badge={
                <Badge variant={r.status === 'applied' ? 'ok' : 'wait'}>
                  {t(`changes.state.${r.status}`)}
                </Badge>
              }
              title={r.reason}
              meta={t('changes.meta', {
                date: formatDate(r.effectiveDate),
                operations: formatNumber(r.operations.length),
                orders: formatNumber(r.impact.ordersNeeded),
              })}
              onSelect={() => navigate(`/changes/${r.id}`)}
            />
          ))}
        </InboxList>
      )}
    </section>
  );
}

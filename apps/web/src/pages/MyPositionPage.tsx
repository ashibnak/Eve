import type { orgV1 } from '@eve/contracts';
import { useApi, useWorkspace } from '../app/workspace';
import { t } from '../i18n/t';
import { formatDate } from '../lib/format';
import { kindLabel, orgPaths } from '../org/api';
import { Badge, ErrorNote, InboxItem, InboxList, Loading, PageHeader } from '../ui/kit';

/**
 * An employee's own view (spec §2): their position(s), manager, approval chain and dotted-line
 * managers; a team lead also sees their team. People appear by name only where the user may read
 * them.
 */
export function MyPositionPage() {
  const { company, asOf } = useWorkspace();
  const me = company?.myPersonId ?? null;
  const positions = useApi<orgV1.PersonPosition[]>(me ? orgPaths.personPositions(me, asOf) : null);
  const manager = useApi<{ manager: orgV1.Manager | null }>(me ? orgPaths.manager(me, asOf) : null);
  const chain = useApi<orgV1.Manager[]>(
    me ? `/org/persons/${me}/approval-chain?levels=5&asOf=${asOf}` : null,
  );
  const informed = useApi<Omit<orgV1.Manager, 'levelsUp'>[]>(
    me ? `/org/persons/${me}/informed?asOf=${asOf}` : null,
  );
  const primary = positions.data?.find((p) => p.kind === 'primary');
  const team = useApi<orgV1.TeamMember[]>(
    primary ? `/org/positions/${primary.positionId}/team?depth=subtree&asOf=${asOf}` : null,
  );

  if (!me) return <p className="text-body text-ink-muted">{t('me.not_linked')}</p>;
  return (
    <section>
      <PageHeader
        eyebrow={company?.nameFa ?? ''}
        title={t('me.title')}
        status={t('card.status', { date: formatDate(asOf) })}
      />
      {positions.loading && <Loading />}
      {positions.error !== null && <ErrorNote error={positions.error} />}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="border-2 border-navy p-5">
          <h2 className="mb-3 text-heading">{t('me.positions')}</h2>
          <ul className="flex flex-col gap-2">
            {positions.data?.map((p) => (
              <li
                key={`${p.positionId}-${p.kind}`}
                className="flex items-center gap-2"
                data-testid="my-position"
              >
                <Badge variant={p.kind === 'primary' ? 'plain' : 'info'}>{kindLabel(p.kind)}</Badge>
                <span className="text-meta text-ink-muted">
                  {t('me.since', { date: formatDate(p.validFrom) })}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="border-2 border-navy p-5">
          <h2 className="mb-3 text-heading">{t('me.manager')}</h2>
          <p className="text-body-strong" data-testid="my-manager">
            {manager.data?.manager
              ? t(
                  manager.data.manager.via === 'primary'
                    ? 'me.manager.primary'
                    : 'me.manager.acting',
                  {
                    levels: String(manager.data.manager.levelsUp),
                  },
                )
              : manager.data
                ? t('me.manager.none')
                : ''}
          </p>
          <p className="mt-3 text-meta text-ink-muted">
            {t('me.chain', { count: String(chain.data?.length ?? 0) })}
            {informed.data && informed.data.length > 0
              ? ` · ${t('me.informed', { count: String(informed.data.length) })}`
              : ''}
          </p>
        </section>
      </div>
      {team.error === null && team.data && team.data.length > 0 && (
        <div className="mt-5">
          <h2 className="mb-3 text-title">{t('me.team')}</h2>
          <InboxList label={t('me.team')}>
            {team.data.map((m) => (
              <InboxItem
                key={m.positionId}
                title={
                  m.incumbents.length === 0
                    ? t('card.vacant_report')
                    : m.incumbents
                        .map((i) =>
                          i.name ? `${i.name.first} ${i.name.last}` : t('card.person_hidden'),
                        )
                        .join(t('ui.list_separator'))
                }
                meta={t('me.team.depth', { depth: String(m.depth) })}
              />
            ))}
          </InboxList>
        </div>
      )}
    </section>
  );
}

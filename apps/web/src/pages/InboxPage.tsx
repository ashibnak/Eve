import type { orgV1 } from '@eve/contracts';
import { useRouter } from '../app/router';
import { useApi, useWorkspace } from '../app/workspace';
import { hasMessage, t } from '../i18n/t';
import { formatDate, formatNumber } from '../lib/format';
import { orgPaths } from '../org/api';
import {
  Badge,
  ErrorNote,
  InboxItem,
  InboxList,
  Loading,
  PageHeader,
  StatTile,
  Stats,
} from '../ui/kit';

export interface ApprovalView {
  id: string;
  type: string;
  companyId: string | null;
  payload: Record<string, unknown>;
  status: string;
  currentStep: number;
  chain: string[];
  requestedBy: string;
  createdAt: string;
  history?: {
    action: string;
    step: number;
    actorId: string | null;
    note: string | null;
    at: string;
  }[];
}

/** The route a waiting request opens (change request or import), or null for other types. */
export function requestRoute(request: ApprovalView): string | null {
  if (request.type === 'org.structure.change')
    return `/changes/${String(request.payload.changeRequestId)}`;
  if (request.type === 'org.structure.import.commit')
    return `/import?id=${String(request.payload.importId)}`;
  return null;
}

export function requestTypeLabel(type: string): string {
  const key = `approvals.type.${type}`;
  return hasMessage(key) ? t(key) : type;
}

export function approvalStatusLabel(status: string): string {
  const key = `approvals.status.${status}`;
  return hasMessage(key) ? t(key) : status;
}

/** Home: the work waiting for the user (design system: an inbox, not a dashboard). */
export function InboxPage() {
  const { company } = useWorkspace();
  const { navigate } = useRouter();
  const inbox = useApi<ApprovalView[]>('/platform/approvals/inbox');
  const mine = useApi<ApprovalView[]>('/platform/approvals/mine');
  const findings = useApi<orgV1.FindingView[]>(
    company?.can.readStructure ? orgPaths.findings(company.companyId) : null,
  );
  const blocking = findings.data?.filter((f) => f.severity === 'blocking').length ?? 0;
  const warnings = findings.data?.filter((f) => f.severity === 'warning').length ?? 0;
  const waiting = inbox.data?.filter((r) => r.status === 'pending') ?? [];

  return (
    <section>
      <PageHeader
        eyebrow={company?.nameFa ?? t('app.shell.eyebrow')}
        title={t('app.shell.title')}
        status={
          waiting.length > 0
            ? t('inbox.status.waiting', { count: formatNumber(waiting.length) })
            : t('app.shell.status')
        }
      />
      <Stats>
        <StatTile
          label={t('inbox.stat.waiting')}
          value={formatNumber(waiting.length)}
          hot={waiting.length > 0}
        />
        {company?.can.readStructure && (
          <>
            <StatTile label={t('inbox.stat.blocking')} value={formatNumber(blocking)} />
            <StatTile label={t('inbox.stat.warnings')} value={formatNumber(warnings)} />
          </>
        )}
      </Stats>
      <h2 className="mb-3 text-title">{t('inbox.waiting.title')}</h2>
      {inbox.loading && <Loading />}
      {inbox.error !== null && <ErrorNote error={inbox.error} />}
      {inbox.data && waiting.length === 0 && (
        <p className="mb-6 text-body text-ink-muted">{t('inbox.waiting.empty')}</p>
      )}
      {waiting.length > 0 && (
        <div className="mb-6">
          <InboxList label={t('inbox.waiting.title')}>
            {waiting.map((r) => (
              <InboxItem
                key={r.id}
                badge={<Badge variant="wait">{t('inbox.badge.your_turn')}</Badge>}
                title={requestTypeLabel(r.type)}
                meta={formatDate(r.createdAt.slice(0, 10))}
                onSelect={() => {
                  const to = requestRoute(r);
                  if (to) navigate(to);
                }}
              />
            ))}
          </InboxList>
        </div>
      )}
      <h2 className="mb-3 text-title">{t('inbox.mine.title')}</h2>
      {mine.data && mine.data.length === 0 && (
        <p className="text-body text-ink-muted">{t('inbox.mine.empty')}</p>
      )}
      {mine.data && mine.data.length > 0 && (
        <InboxList label={t('inbox.mine.title')}>
          {mine.data.slice(0, 20).map((r) => (
            <InboxItem
              key={r.id}
              badge={
                <Badge
                  variant={
                    r.status === 'approved' ? 'ok' : r.status === 'pending' ? 'wait' : 'warn'
                  }
                >
                  {approvalStatusLabel(r.status)}
                </Badge>
              }
              title={requestTypeLabel(r.type)}
              meta={formatDate(r.createdAt.slice(0, 10))}
              onSelect={() => {
                const to = requestRoute(r);
                if (to) navigate(to);
              }}
            />
          ))}
        </InboxList>
      )}
    </section>
  );
}

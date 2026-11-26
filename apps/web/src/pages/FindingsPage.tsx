import type { orgV1 } from '@eve/contracts';
import { useState } from 'react';
import { Link } from '../app/router';
import { useApi, useWorkspace } from '../app/workspace';
import { t } from '../i18n/t';
import { formatDate, formatNumber } from '../lib/format';
import { orgApi, orgPaths, severityLabel } from '../org/api';
import { Button } from '../ui/Button';
import {
  Badge,
  Dialog,
  ErrorNote,
  InboxItem,
  InboxList,
  Loading,
  PageHeader,
  ReasonForm,
  Select,
} from '../ui/kit';

const TABS = ['open', 'accepted', 'resolved'] as const;
type Tab = (typeof TABS)[number];

/** The findings inbox (spec §9): blocking first, then warnings; accept a warning with a reason. */
export function FindingsPage() {
  const { company } = useWorkspace();
  const [tab, setTab] = useState<Tab>('open');
  const [selected, setSelected] = useState<string | null>(null);
  const [acting, setActing] = useState<'accept' | 'reopen' | null>(null);
  const [running, setRunning] = useState(false);
  const findings = useApi<orgV1.FindingView[]>(
    company ? orgPaths.findings(company.companyId, `&status=${tab}`) : null,
  );
  const can = company?.can.manageFindings ?? false;
  const current = findings.data?.find((f) => f.id === selected) ?? null;
  const askAccept = () => setActing('accept');
  const askReopen = () => setActing('reopen');

  return (
    <section>
      <PageHeader
        eyebrow={company?.nameFa ?? ''}
        title={t('findings.title')}
        status={
          findings.data
            ? t('findings.status', { count: formatNumber(findings.data.length) })
            : undefined
        }
        tools={
          <>
            <Select
              id="findings-tab"
              label={t('findings.show')}
              value={tab}
              onChange={(v) => {
                setTab(v as Tab);
                setSelected(null);
              }}
              options={TABS.map((s) => ({
                value: s,
                label: t(`findings.tab.${s}`),
              }))}
            />
            {can && company && (
              <Button
                disabled={running}
                onClick={() => {
                  setRunning(true);
                  orgApi
                    .runRules(company.companyId)
                    .then(findings.reload)
                    .finally(() => setRunning(false));
                }}
              >
                {t('findings.run')}
              </Button>
            )}
            {can && tab === 'open' && (
              <Button
                variant="primary"
                disabled={!current || current.severity !== 'warning'}
                onClick={askAccept}
              >
                {t('findings.accept')}
              </Button>
            )}
            {can && tab === 'accepted' && (
              <Button disabled={!current} onClick={askReopen}>
                {t('findings.reopen')}
              </Button>
            )}
          </>
        }
      />
      {findings.loading && <Loading />}
      {findings.error !== null && <ErrorNote error={findings.error} />}
      {findings.data && findings.data.length === 0 && (
        <p className="text-body text-ink-muted">{t('findings.empty')}</p>
      )}
      {findings.data && findings.data.length > 0 && (
        <InboxList label={t('findings.title')}>
          {findings.data.map((f) => (
            <InboxItem
              key={f.id}
              selected={f.id === selected}
              onSelect={() => setSelected(f.id === selected ? null : f.id)}
              badge={
                <Badge
                  variant={
                    f.severity === 'blocking' ? 'block' : f.severity === 'warning' ? 'warn' : 'info'
                  }
                >
                  {severityLabel(f.severity)}
                </Badge>
              }
              title={t('findings.item', { code: f.code, key: f.key })}
              meta={
                f.status === 'accepted' && f.accepted
                  ? t('findings.accepted_meta', {
                      reason: f.accepted.reason,
                      date: formatDate(f.accepted.at.slice(0, 10)),
                    })
                  : t('findings.seen', { date: formatDate(f.firstSeenAt.slice(0, 10)) })
              }
              warn={f.severity === 'blocking'}
              actions={
                f.subject.type === 'position' ? (
                  <Link to={`/positions/${f.subject.id}`} className="text-meta underline">
                    {t('findings.open_position')}
                  </Link>
                ) : undefined
              }
            />
          ))}
        </InboxList>
      )}
      <Dialog
        open={acting !== null}
        title={acting === 'reopen' ? t('findings.reopen') : t('findings.accept')}
        onClose={() => setActing(null)}
      >
        {acting === 'accept' && (
          <p className="mb-4 text-meta text-ink-muted">{t('findings.accept.help')}</p>
        )}
        <ReasonForm
          submitLabel={acting === 'reopen' ? t('findings.reopen') : t('findings.accept')}
          onCancel={() => setActing(null)}
          onSubmit={async (reason) => {
            if (!current) return;
            if (acting === 'accept') await orgApi.acceptFinding(current.id, reason);
            else await orgApi.reopenFinding(current.id, reason);
            setActing(null);
            setSelected(null);
            findings.reload();
          }}
        />
      </Dialog>
    </section>
  );
}

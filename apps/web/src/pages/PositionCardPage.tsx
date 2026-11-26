import type { orgV1 } from '@eve/contracts';
import { useState } from 'react';
import { Link } from '../app/router';
import { useApi, useWorkspace } from '../app/workspace';
import { t } from '../i18n/t';
import { formatDate, formatNumber } from '../lib/format';
import {
  kindLabel,
  orgApi,
  orgPaths,
  positionTypeLabel,
  severityLabel,
  statusLabel,
} from '../org/api';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Badge, Dialog, ErrorNote, Loading, PageHeader, ReasonForm } from '../ui/kit';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-label text-ink-muted">{label}</dt>
      <dd className="text-body-strong">{children}</dd>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-2 border-navy bg-surface p-5">
      <h2 className="mb-3 text-heading">{title}</h2>
      {children}
    </section>
  );
}

/** One position on the date asked (spec §9 position card). */
export function PositionCardPage({ id }: { id: string }) {
  const { company, asOf } = useWorkspace();
  const position = useApi<orgV1.PositionView>(orgPaths.position(id, asOf));
  const history = useApi<orgV1.PositionHistory>(orgPaths.history(id));
  const team = useApi<orgV1.TeamMember[]>(orgPaths.team(id, asOf));
  const findings = useApi<orgV1.FindingView[]>(
    company ? orgPaths.findings(company.companyId, `&subjectId=${id}`) : null,
  );
  const [correcting, setCorrecting] = useState(false);
  const [titleFa, setTitleFa] = useState('');
  const [titleEn, setTitleEn] = useState('');

  if (position.loading) return <Loading />;
  if (position.error !== null || !position.data) return <ErrorNote error={position.error} />;
  const p = position.data;
  const version = history.data?.versions.find(
    (v) => v.validFrom <= asOf && (v.validTo === null || v.validTo > asOf),
  );
  const above = history.data?.lines.find(
    (l) => l.kind === 'direct' && l.validFrom <= asOf && (l.validTo === null || l.validTo > asOf),
  );
  const dotted =
    history.data?.lines.filter(
      (l) => l.kind !== 'direct' && l.validFrom <= asOf && (l.validTo === null || l.validTo > asOf),
    ) ?? [];

  return (
    <section>
      <PageHeader
        eyebrow={`${t('card.eyebrow')} · ${p.code}`}
        title={p.title.fa}
        status={t('card.status', { date: formatDate(asOf) })}
        tools={
          company?.can.correct &&
          version && (
            <Button
              variant="primary"
              onClick={() => {
                setTitleFa(p.title.fa);
                setTitleEn(p.title.en ?? '');
                setCorrecting(true);
              }}
            >
              {t('card.correct')}
            </Button>
          )
        }
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title={t('card.facts')}>
          <dl className="grid grid-cols-2 gap-3">
            <Fact label={t('card.unit')}>{version?.unitName ?? ''}</Fact>
            <Fact label={t('card.type')}>{positionTypeLabel(p.type)}</Fact>
            <Fact label={t('card.status_label')}>{statusLabel(p.status)}</Fact>
            <Fact label={t('card.fte')}>{formatNumber(p.fte, 3)}</Fact>
            <Fact label={t('card.supervisory')}>{p.supervisory ? t('ui.yes') : t('ui.no')}</Fact>
            <Fact label={t('card.job')}>{p.jobId ?? t('card.no_job')}</Fact>
            <Fact label={t('card.legacy')}>{p.legacyCode ?? '—'}</Fact>
            <Fact label={t('card.above')}>
              {above ? (
                <Link to={`/positions/${above.toPositionId}`} className="underline">
                  {above.toCode}
                </Link>
              ) : (
                t('card.top')
              )}
            </Fact>
          </dl>
        </Panel>
        <Panel title={t('card.incumbents')}>
          {p.incumbents.length === 0 && (
            <p className="text-body text-ink-muted">
              <Badge variant="wait">{t('org.chart.vacant')}</Badge>
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {p.incumbents.map((i) => (
              <li key={`${i.personId}-${i.kind}`} className="flex flex-wrap items-center gap-2">
                <span className="text-body-strong">
                  {i.name ? `${i.name.first} ${i.name.last}` : t('card.person_hidden')}
                </span>
                {i.personnelCode && (
                  <span className="text-meta text-ink-muted">{i.personnelCode}</span>
                )}
                <Badge variant={i.kind === 'primary' ? 'plain' : 'info'}>{kindLabel(i.kind)}</Badge>
                {!i.active && <Badge variant="warn">{t('card.inactive')}</Badge>}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title={t('card.reports')}>
          {team.data && team.data.length === 0 && (
            <p className="text-body text-ink-muted">{t('card.no_reports')}</p>
          )}
          <ul className="flex flex-col gap-1">
            {team.data?.map((m) => (
              <li key={m.positionId}>
                <Link to={`/positions/${m.positionId}`} className="text-body-strong underline">
                  {m.incumbents.length === 0
                    ? t('card.vacant_report')
                    : m.incumbents
                        .map((i) =>
                          i.name ? `${i.name.first} ${i.name.last}` : t('card.person_hidden'),
                        )
                        .join(t('ui.list_separator'))}
                </Link>
              </li>
            ))}
          </ul>
          {dotted.length > 0 && (
            <>
              <h3 className="mt-4 text-label text-ink-muted">{t('card.dotted')}</h3>
              <ul>
                {dotted.map((l) => (
                  <li key={`${l.toPositionId}-${l.validFrom}`}>
                    <Link to={`/positions/${l.toPositionId}`} className="underline">
                      {l.toCode}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
        <Panel title={t('card.findings')}>
          {findings.data && findings.data.length === 0 && (
            <p className="text-body text-ink-muted">{t('card.no_findings')}</p>
          )}
          <ul className="flex flex-col gap-2">
            {findings.data?.map((f) => (
              <li key={f.id} className="flex items-center gap-2">
                <Badge variant={f.severity === 'blocking' ? 'block' : 'warn'}>
                  {severityLabel(f.severity)}
                </Badge>
                <span className="text-body">{t('findings.rule', { code: f.code })}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
      <section className="mt-5 border-2 border-navy bg-surface p-5">
        <h2 className="mb-3 text-heading">{t('card.history')}</h2>
        <ol className="flex flex-col gap-2">
          {history.data?.versions.map((v) => (
            <li key={v.validFrom} className="text-body">
              <span className="text-body-strong">{formatDate(v.validFrom)}</span>
              {' · '}
              {v.title.fa} · {v.unitName ?? ''}
              {v.validTo && (
                <span className="text-ink-muted">{` · ${t('card.until', { date: formatDate(v.validTo) })}`}</span>
              )}
            </li>
          ))}
          {history.data?.assignments.map((a) => (
            <li key={`${a.personId}-${a.validFrom}-${a.kind}`} className="text-body">
              <span className="text-body-strong">{formatDate(a.validFrom)}</span>
              {' · '}
              {a.name ? `${a.name.first} ${a.name.last}` : t('card.person_hidden')} ·{' '}
              {kindLabel(a.kind)}
              {a.validTo && (
                <span className="text-ink-muted">{` · ${t('card.until', { date: formatDate(a.validTo) })}`}</span>
              )}
            </li>
          ))}
        </ol>
      </section>
      <Dialog
        open={correcting}
        title={t('card.correct.title')}
        onClose={() => setCorrecting(false)}
      >
        <p className="mb-4 text-meta text-ink-muted">
          {t('card.correct.help', { date: formatDate(version?.validFrom) })}
        </p>
        <div className="mb-4 flex flex-col gap-3">
          <Field
            id="title-fa"
            label={t('card.correct.title_fa')}
            value={titleFa}
            onChange={(e) => setTitleFa(e.target.value)}
          />
          <Field
            id="title-en"
            label={t('card.correct.title_en')}
            value={titleEn}
            onChange={(e) => setTitleEn(e.target.value)}
          />
        </div>
        <ReasonForm
          submitLabel={t('card.correct.submit')}
          onCancel={() => setCorrecting(false)}
          onSubmit={async (reason) => {
            const changes: Record<string, string | null> = {};
            if (titleFa.trim() && titleFa.trim() !== p.title.fa) changes.titleFa = titleFa.trim();
            if ((titleEn.trim() || null) !== p.title.en) changes.titleEn = titleEn.trim() || null;
            if (Object.keys(changes).length > 0) {
              await orgApi.correctPosition(id, {
                versionFrom: version!.validFrom,
                changes,
                reason,
              });
            }
            setCorrecting(false);
            position.reload();
            history.reload();
          }}
        />
      </Dialog>
    </section>
  );
}

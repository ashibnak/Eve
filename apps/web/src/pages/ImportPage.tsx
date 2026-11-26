import { useEffect, useState } from 'react';
import { api, ApiError, upload } from '../api';
import { useRouter } from '../app/router';
import { useWorkspace } from '../app/workspace';
import { hasMessage, t } from '../i18n/t';
import { formatDate, formatNumber, type IsoDate } from '../lib/format';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Badge, DateInput, InboxItem, InboxList, PageHeader } from '../ui/kit';

interface ImportView {
  id: string;
  status:
    | 'uploaded'
    | 'mapped'
    | 'validated'
    | 'previewed'
    | 'awaiting_approval'
    | 'committed'
    | 'discarded';
  effectiveDate: string;
  mapping: Record<string, { entity: string; columns: Record<string, string> }> | null;
  findings:
    | { severity: 'blocking' | 'warning'; code: string; message: string; rowNumber?: number }[]
    | null;
  counts: Record<string, number>;
  diff:
    { entity: string; key: string; kind: 'added' | 'changed' | 'removed' | 'unchanged' }[] | null;
  rowErrors?: { sheet: string; rowNumber: number; errors: { message: string }[] }[];
}

const STEPS = ['upload', 'mapping', 'findings', 'preview', 'commit'] as const;
type Step = (typeof STEPS)[number];

function stepOf(view: ImportView | null): Step {
  if (!view) return 'upload';
  if (view.status === 'uploaded') return 'mapping';
  if (view.status === 'mapped' || view.status === 'validated') return 'findings';
  if (view.status === 'previewed') return 'preview';
  return 'commit';
}

/** The structure import wizard (spec §6 steps 1-6): upload, mapping, checks, preview, commit. */
export function ImportPage() {
  const { company, today } = useWorkspace();
  const { location } = useRouter();
  const [view, setView] = useState<ImportView | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [effectiveDate, setEffectiveDate] = useState<IsoDate>(today);
  const [source, setSource] = useState('hr-structure-excel');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const resume = location.query.get('id');

  useEffect(() => {
    if (resume) api<ImportView>('GET', `/platform/imports/${resume}`).then(setView).catch(setError);
  }, [resume]);

  const run = async (action: () => Promise<ImportView>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await action());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  if (!company) return null;
  const step = stepOf(view);
  const blocking = view?.findings?.filter((f) => f.severity === 'blocking') ?? [];

  const actions: Record<Step, { label: string; disabled: boolean; go: () => void }> = {
    upload: {
      label: t('import.upload'),
      disabled: !file || !source.trim(),
      go: () =>
        void run(() =>
          upload<ImportView>(
            '/platform/imports',
            {
              target: 'org.structure',
              companyId: company.companyId,
              effectiveDate,
              sourceName: source.trim(),
            },
            file!,
          ),
        ),
    },
    mapping: {
      label: t('import.use_mapping'),
      disabled: !view?.mapping,
      go: () =>
        void run(() =>
          api<ImportView>('PUT', `/platform/imports/${view!.id}/mapping`, {
            mapping: view!.mapping,
            save: true,
          }),
        ),
    },
    findings: {
      label: view?.status === 'validated' ? t('import.preview') : t('import.validate'),
      disabled: view?.status === 'validated' && blocking.length > 0,
      go: () =>
        void run(() =>
          view!.status === 'validated'
            ? api<ImportView>('GET', `/platform/imports/${view!.id}/preview`)
            : api<ImportView>('POST', `/platform/imports/${view!.id}/validate`),
        ),
    },
    preview: {
      label: t('import.commit'),
      disabled: !reason.trim(),
      go: () =>
        void run(() =>
          api<ImportView>('POST', `/platform/imports/${view!.id}/commit`, {
            reason: reason.trim(),
          }),
        ),
    },
    commit: { label: t('import.again'), disabled: false, go: () => setView(null) },
  };
  const action = actions[step];

  return (
    <section>
      <PageHeader
        eyebrow={company.nameFa}
        title={t('import.title')}
        status={t(`import.step.${step}.help`)}
        tools={
          <Button
            variant={step === 'commit' ? 'secondary' : 'primary'}
            disabled={busy || action.disabled}
            onClick={action.go}
          >
            {action.label}
          </Button>
        }
      />
      <ol className="mb-6 flex flex-wrap gap-2" aria-label={t('import.steps')}>
        {STEPS.map((s, i) => (
          <li key={s}>
            <Badge variant={s === step ? 'block' : STEPS.indexOf(step) > i ? 'ok' : 'plain'}>
              {`${formatNumber(i + 1)}. ${t(`import.step.${s}`)}`}
            </Badge>
          </li>
        ))}
      </ol>
      {error !== null && (
        <p
          role="alert"
          className="mb-4 border-2 border-red-dark px-4 py-3 text-body-strong text-red-dark"
        >
          {error instanceof ApiError && error.status === 409
            ? t('import.refused')
            : t('ui.error.generic')}
        </p>
      )}
      {step === 'upload' && (
        <div className="flex flex-wrap items-end gap-4">
          <DateInput
            id="import-date"
            label={t('import.effective_date')}
            value={effectiveDate}
            onChange={setEffectiveDate}
          />
          <Field
            id="import-source"
            label={t('import.source')}
            hint={t('import.source.help')}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor="import-file" className="text-label">
              {t('import.file')}
            </label>
            <input
              id="import-file"
              type="file"
              accept=".xlsx,.csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="h-11 border-2 border-navy px-3 py-2 text-body"
            />
          </div>
        </div>
      )}
      {step === 'mapping' && view && (
        <div className="flex flex-col gap-4">
          {!view.mapping && (
            <p
              role="alert"
              className="border-2 border-red-dark px-4 py-3 text-body-strong text-red-dark"
            >
              {t('import.no_mapping')}
            </p>
          )}
          {view.mapping &&
            Object.entries(view.mapping).map(([sheet, m]) => (
              <section key={sheet} className="border-2 border-navy p-4">
                <h2 className="mb-2 text-heading">
                  {t('import.sheet', {
                    sheet,
                    entity: hasMessage(`import.entity.${m.entity}`)
                      ? t(`import.entity.${m.entity}` as 'import.entity.unit')
                      : m.entity,
                  })}
                </h2>
                <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {Object.entries(m.columns).map(([header, field]) => (
                    <li key={header} className="text-body">
                      <span className="text-body-strong">{header}</span>
                      {` ← ${field}`}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      )}
      {step === 'findings' && view && (
        <>
          {view.status === 'mapped' && (
            <p className="text-body text-ink-muted">{t('import.not_validated')}</p>
          )}
          {view.findings && view.findings.length === 0 && (
            <p className="text-body">{t('import.no_findings')}</p>
          )}
          {view.findings && view.findings.length > 0 && (
            <InboxList label={t('import.step.findings')}>
              {view.findings.slice(0, 200).map((f, i) => (
                <InboxItem
                  key={`${f.code}-${i}`}
                  badge={
                    <Badge variant={f.severity === 'blocking' ? 'block' : 'warn'}>
                      {t(`org.finding.severity.${f.severity}`)}
                    </Badge>
                  }
                  title={f.message}
                  meta={f.rowNumber ? t('import.row', { row: formatNumber(f.rowNumber) }) : f.code}
                  warn={f.severity === 'blocking'}
                />
              ))}
            </InboxList>
          )}
        </>
      )}
      {step === 'preview' && view && (
        <div className="flex flex-col gap-4">
          <p className="text-body-strong" data-testid="import-counts">
            {t('import.counts', {
              added: formatNumber(view.counts.added ?? 0),
              changed: formatNumber(view.counts.changed ?? 0),
              removed: formatNumber(view.counts.removed ?? 0),
            })}
          </p>
          <p className="text-meta text-ink-muted">
            {t('import.proposed', {
              count: formatNumber(
                view.diff?.filter((d) => d.entity === 'position' && d.key.startsWith('proposed:'))
                  .length ?? 0,
              ),
            })}
          </p>
          <div className="flex flex-col gap-1">
            <label htmlFor="import-reason" className="text-label">
              {t('ui.reason')}
            </label>
            <input
              id="import-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-11 max-w-xl border-2 border-navy px-3 text-body-strong focus-visible:outline-2 focus-visible:outline-focus"
            />
          </div>
        </div>
      )}
      {step === 'commit' && view && (
        <p className="text-title" data-testid="import-result">
          {view.status === 'awaiting_approval'
            ? t('import.awaiting_approval')
            : t('import.committed', { date: formatDate(view.effectiveDate) })}
        </p>
      )}
    </section>
  );
}

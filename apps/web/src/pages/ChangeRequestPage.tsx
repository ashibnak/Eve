import type { orgV1 } from '@eve/contracts';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiError } from '../api';
import { useRouter } from '../app/router';
import { useApi, useWorkspace } from '../app/workspace';
import { hasMessage, t } from '../i18n/t';
import { addDays, formatDate, formatNumber, type IsoDate } from '../lib/format';
import { orgApi, orgPaths, type Structure } from '../org/api';
import { OrgChart } from '../org/chart/OrgChart';
import {
  applyOperations,
  type Draft,
  newDraft,
  OperationEditor,
  toOperations,
} from '../org/operations';
import { Button } from '../ui/Button';
import {
  ApprovalChain,
  type ChainStep,
  DateInput,
  Dialog,
  ErrorNote,
  Loading,
  PageHeader,
  Select,
} from '../ui/kit';
import { approvalStatusLabel, type ApprovalView } from './InboxPage';

const VIEWS = ['before', 'after'] as const;
const OPS: Draft['op'][] = [
  'unit.create',
  'unit.update',
  'unit.close',
  'position.create',
  'position.update',
  'position.close',
];

function roleLabel(role: string): string {
  const key = `roles.${role}`;
  return hasMessage(key) ? t(key) : role;
}

/** The steps of an approval request for ApprovalChain: who approved, whose turn, what next. */
function chainSteps(approval: ApprovalView): ChainStep[] {
  return approval.chain.map((role, i) => {
    const decided = approval.status === 'approved' || i < approval.currentStep;
    const now = approval.status === 'pending' && i === approval.currentStep;
    return {
      label: roleLabel(role),
      state: decided ? 'done' : now ? 'now' : 'next',
    };
  });
}

function Impact({ impact }: { impact: orgV1.Impact }) {
  return (
    <section className="border-2 border-navy p-5" aria-label={t('changes.impact')}>
      <h2 className="mb-3 text-heading">{t('changes.impact')}</h2>
      <ul className="flex flex-col gap-1 text-body" data-testid="impact">
        <li>{t('changes.impact.moved', { count: formatNumber(impact.movedPeople.length) })}</li>
        <li>{t('changes.impact.orders', { count: formatNumber(impact.ordersNeeded) })}</li>
        <li>
          {t('changes.impact.managers', { count: formatNumber(impact.managerChanges.length) })}
        </li>
        <li>
          {t('changes.impact.vacated', { count: formatNumber(impact.vacatedPositions.length) })}
        </li>
        <li>
          {t('changes.impact.warnings', {
            opened: formatNumber(impact.warnings.opened.length),
            resolved: formatNumber(impact.warnings.resolved.length),
          })}
        </li>
        <li className="text-ink-muted">{t('changes.impact.grades')}</li>
      </ul>
    </section>
  );
}

/** A new change request, or one already submitted (spec §9: before/after, impact, decision). */
export function ChangeRequestPage({ id }: { id: string | null }) {
  const request = useApi<orgV1.ChangeRequestView>(id ? orgPaths.changeRequest(id) : null);
  if (!id) return <Editor existing={null} />;
  if (request.loading) return <Loading />;
  if (request.error !== null || !request.data) return <ErrorNote error={request.error} />;
  return <Detail request={request.data} reload={request.reload} />;
}

function Editor({
  existing,
  onDone,
}: {
  existing: orgV1.ChangeRequestView | null;
  onDone?: () => void;
}) {
  const { company, today } = useWorkspace();
  const { navigate } = useRouter();
  const [effectiveDate, setEffectiveDate] = useState<IsoDate>(
    (existing?.effectiveDate as IsoDate | undefined) ?? addDays(today, 7),
  );
  const [reason, setReason] = useState(existing?.reason ?? '');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [kind, setKind] = useState<Draft['op']>('position.create');
  const [view, setView] = useState<'before' | 'after'>('after');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const structure = useApi<Structure>(
    company ? orgPaths.structure(company.companyId, effectiveDate) : null,
  );
  const profile = useApi<{ levels: { id: string; nameFa: string }[] }>(
    company ? orgPaths.profile(company.companyId) : null,
  );
  const byCode = useMemo(() => {
    const map = new Map<string, Structure['positions'][number]>();
    for (const p of structure.data?.positions ?? []) {
      map.set(p.code, p);
      if (p.legacyCode) map.set(p.legacyCode, p);
    }
    return map;
  }, [structure.data]);
  const operations = useMemo(() => toOperations(drafts, byCode), [drafts, byCode]);
  const preview = useMemo(
    () => (structure.data && operations ? applyOperations(structure.data, operations) : null),
    [structure.data, operations],
  );

  if (!company) return null;
  const submit = async () => {
    if (!operations || operations.length === 0 || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await orgApi.resubmitChange(existing.id, {
          effectiveDate,
          reason: reason.trim(),
          operations,
          note: reason.trim(),
        });
        onDone?.();
      } else {
        const created = await orgApi.submitChange({
          companyId: company.companyId,
          effectiveDate,
          reason: reason.trim(),
          operations,
        });
        navigate(`/changes/${created.id}`);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <PageHeader
        eyebrow={company.nameFa}
        title={existing ? t('changes.resubmit.title') : t('changes.new.title')}
        status={t('changes.new.status')}
        tools={
          <Button
            variant="primary"
            disabled={busy || !operations || operations.length === 0 || !reason.trim()}
            onClick={submit}
          >
            {existing ? t('changes.resubmit') : t('changes.submit')}
          </Button>
        }
      />
      <div className="mb-5 flex flex-wrap items-end gap-4">
        <DateInput
          id="effective-date"
          label={t('changes.effective_date')}
          value={effectiveDate}
          onChange={setEffectiveDate}
        />
        <div className="flex min-w-80 flex-1 flex-col gap-1">
          <label htmlFor="change-reason" className="text-label">
            {t('ui.reason')}
          </label>
          <input
            id="change-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="h-11 border-2 border-navy bg-surface px-3 text-body-strong focus-visible:outline-2 focus-visible:outline-focus"
          />
        </div>
      </div>
      {error !== null && (
        <p
          role="alert"
          className="mb-4 border-2 border-red-dark px-4 py-3 text-body-strong text-red-dark"
        >
          {error instanceof ApiError && (error.status === 400 || error.status === 409)
            ? t('changes.refused')
            : t('ui.error.generic')}
        </p>
      )}
      <div className="mb-5 flex flex-col gap-3">
        {structure.data &&
          drafts.map((d, i) => (
            <OperationEditor
              key={i}
              index={i}
              draft={d}
              drafts={drafts}
              structure={structure.data!}
              levels={profile.data?.levels ?? []}
              onChange={(next) => setDrafts((all) => all.map((x, j) => (j === i ? next : x)))}
              onRemove={() => setDrafts((all) => all.filter((_, j) => j !== i))}
            />
          ))}
        <div className="flex items-end gap-3">
          <Select
            id="new-op"
            label={t('changes.op.add_kind')}
            value={kind}
            onChange={(v) => setKind(v as Draft['op'])}
            options={OPS.map((op) => ({ value: op, label: t(`changes.op.${op}`) }))}
          />
          <Button onClick={() => setDrafts((all) => [...all, newDraft(kind, all.length + 1)])}>
            <Plus size={16} strokeWidth={2.5} aria-hidden="true" />
            {t('changes.op.add')}
          </Button>
        </div>
      </div>
      {structure.loading && <Loading />}
      {structure.data && (
        <>
          <div className="mb-3 flex gap-2" role="tablist" aria-label={t('changes.preview')}>
            {VIEWS.map((v) => (
              <Button
                key={v}
                role="tab"
                aria-selected={view === v}
                variant={view === v ? 'secondary' : 'ghost'}
                onClick={() => setView(v)}
              >
                {t(`changes.${v}`)}
              </Button>
            ))}
          </div>
          <OrgChart
            key={view}
            structure={view === 'after' && preview ? preview.after : structure.data}
            changed={view === 'after' ? preview?.changed : undefined}
            onOpen={() => undefined}
            levels={4}
            label={t(`changes.${view}`)}
          />
        </>
      )}
    </section>
  );
}

function Detail({ request, reload }: { request: orgV1.ChangeRequestView; reload: () => void }) {
  const { company, me } = useWorkspace();
  const approval = useApi<ApprovalView>(`/platform/approvals/${request.approvalRequestId}`);
  const [deciding, setDeciding] = useState<'reject' | 'return' | null>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const a = approval.data;
  const mine = request.requestedBy === me.id;
  const myTurn = Boolean(a && a.status === 'pending' && !mine && company?.can.approveChange);

  if (editing) {
    return (
      <Editor
        existing={request}
        onDone={() => {
          setEditing(false);
          reload();
          approval.reload();
        }}
      />
    );
  }
  const decide = async (decision: 'approve' | 'reject' | 'return', text: string | null) => {
    setError(null);
    try {
      await orgApi.decide(request.approvalRequestId, decision, text);
      setDeciding(null);
      reload();
      approval.reload();
    } catch (e) {
      setError(e);
    }
  };

  const approve = () => void decide('approve', null);
  const askReturn = () => setDeciding('return');
  const askReject = () => setDeciding('reject');

  return (
    <section>
      <PageHeader
        eyebrow={t('changes.eyebrow', { date: formatDate(request.effectiveDate) })}
        title={request.reason}
        status={
          a ? t('changes.approval_status', { status: approvalStatusLabel(a.status) }) : undefined
        }
        tools={
          <>
            {myTurn && (
              <>
                <Button variant="primary" onClick={approve}>
                  {t('changes.approve')}
                </Button>
                <Button onClick={askReturn}>{t('changes.return')}</Button>
                <Button variant="ghost" onClick={askReject}>
                  {t('changes.reject')}
                </Button>
              </>
            )}
            {mine && a?.status === 'returned' && (
              <Button variant="primary" onClick={() => setEditing(true)}>
                {t('changes.edit_and_resubmit')}
              </Button>
            )}
          </>
        }
      />
      {error !== null && <ErrorNote error={error} />}
      {a && (
        <div className="mb-5">
          <ApprovalChain label={t('changes.chain')} steps={chainSteps(a)} />
          {a.history
            ?.filter((h) => h.note)
            .map((h) => (
              <p key={`${h.at}-${h.action}`} className="mt-2 text-meta text-ink-muted">
                {t('changes.note', { note: h.note!, date: formatDate(h.at.slice(0, 10)) })}
              </p>
            ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Impact impact={request.impact} />
        <section className="border-2 border-navy p-5">
          <h2 className="mb-3 text-heading">{t('changes.operations')}</h2>
          <ol className="flex list-decimal flex-col gap-1 ps-5 text-body">
            {request.operations.map((op, i) => (
              <li key={i}>{t(`changes.op.${op.op}`)}</li>
            ))}
          </ol>
        </section>
      </div>
      <Dialog
        open={deciding !== null}
        title={deciding === 'reject' ? t('changes.reject') : t('changes.return')}
        onClose={() => setDeciding(null)}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (deciding && note.trim()) void decide(deciding, note.trim());
          }}
        >
          <label htmlFor="decision-note" className="text-label">
            {t('changes.note_label')}
          </label>
          <textarea
            id="decision-note"
            required
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="border-2 border-navy px-3 py-2 text-body focus-visible:outline-2 focus-visible:outline-focus"
          />
          <div className="flex gap-3">
            <Button type="submit" variant="primary" disabled={!note.trim()}>
              {deciding === 'reject' ? t('changes.reject') : t('changes.return')}
            </Button>
            <Button onClick={() => setDeciding(null)}>{t('ui.cancel')}</Button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}

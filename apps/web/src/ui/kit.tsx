import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { t } from '../i18n/t';
import { type IsoDate, formatDateInput, parseDateInput } from '../lib/format';
import { ApiError } from '../api';
import { Button } from './Button';

/* Design-system pieces (docs/design-system): 2px navy frames, square corners, hard shadows. */

export type BadgeVariant = 'plain' | 'wait' | 'info' | 'ok' | 'warn' | 'block';
const BADGE: Record<BadgeVariant, string> = {
  plain: 'border-navy bg-surface text-navy',
  wait: 'border-navy bg-surface-cream text-navy',
  info: 'border-navy bg-steel text-navy',
  ok: 'border-success bg-surface text-success',
  warn: 'border-red-dark bg-surface text-red-dark',
  block: 'border-navy bg-red text-on-red',
};
/** Status is never told by colour alone (design system): a mark goes with it. */
const MARK: Partial<Record<BadgeVariant, string>> = { ok: '✓', warn: '!', block: '■' };

export function Badge({
  variant = 'plain',
  children,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap border-2 px-2 text-label leading-5 ${BADGE[variant]}`}
    >
      {MARK[variant] && <span aria-hidden="true">{MARK[variant]}</span>}
      {children}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  status,
  tools,
}: {
  eyebrow: string;
  title: string;
  status?: string | undefined;
  tools?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="text-label text-red-dark">{eyebrow}</p>
        <h1 className="text-page-title">{title}</h1>
        {status && <p className="text-body text-ink-muted">{status}</p>}
      </div>
      {tools && <div className="flex flex-wrap items-end gap-3">{tools}</div>}
    </header>
  );
}

export function StatTile({
  label,
  value,
  note,
  hot = false,
}: {
  label: string;
  value: string;
  note?: string;
  hot?: boolean;
}) {
  return (
    <div className={`border-2 border-navy px-4 py-3 shadow-hard ${hot ? 'bg-red' : 'bg-surface'}`}>
      <p className={`text-label ${hot ? 'text-on-red' : 'text-ink-muted'}`}>{label}</p>
      <p className={`text-figure-lg tabular-nums ${hot ? 'text-on-red' : 'text-navy'}`}>{value}</p>
      {note && <p className={`text-meta ${hot ? 'text-red-tint' : 'text-ink-muted'}`}>{note}</p>}
    </div>
  );
}

export function Stats({ children }: { children: ReactNode }) {
  return (
    <div className="mb-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
  );
}

/** A work-inbox list: one framed row per item (design system InboxItem). */
export function InboxList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <ul aria-label={label} className="border-2 border-navy bg-surface">
      {children}
    </ul>
  );
}

export function InboxItem({
  title,
  meta,
  warn = false,
  selected = false,
  badge,
  onSelect,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  warn?: boolean;
  selected?: boolean;
  badge?: ReactNode;
  onSelect?: () => void;
  actions?: ReactNode;
}) {
  return (
    <li
      className={`flex flex-wrap items-center gap-3 border-b-2 border-navy px-4 py-3 last:border-b-0 ${
        selected ? 'bg-navy text-cream-on-navy' : 'hover:bg-surface-cream'
      }`}
    >
      {badge}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={onSelect ? selected : undefined}
        className="min-w-0 flex-1 text-start focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span className="block text-body-strong">{title}</span>
        {meta && (
          <span
            className={`block text-meta ${selected ? 'text-steel-soft' : warn ? 'font-extrabold text-red-dark' : 'text-ink-muted'}`}
          >
            {meta}
          </span>
        )}
      </button>
      {actions}
    </li>
  );
}

export interface ChainStep {
  label: string;
  state: 'done' | 'now' | 'next';
  note?: string;
}

/** Who approved, whose turn it is, what comes next (design system ApprovalChain). */
export function ApprovalChain({ steps, label }: { steps: ChainStep[]; label: string }) {
  return (
    <ol aria-label={label} className="flex flex-wrap items-center gap-2">
      {steps.map((step, i) => (
        <li key={`${step.label}-${i}`} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true" className="h-0.5 w-6 bg-navy" />}
          <span
            className={`inline-flex size-5 items-center justify-center border-2 border-navy text-caption ${
              step.state === 'done'
                ? 'bg-navy text-cream-on-navy'
                : step.state === 'now'
                  ? 'bg-red text-on-red'
                  : 'bg-surface'
            }`}
          >
            {i + 1}
          </span>
          <span
            className={
              step.state === 'next' ? 'text-body text-ink-muted' : 'text-body-strong text-navy'
            }
          >
            {step.label}
            {step.note && <small className="block text-caption text-ink-muted">{step.note}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A modal dialog on the native <dialog> element (focus trap and Escape for free). */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-full max-w-lg border-2 border-navy bg-surface p-6 text-navy shadow-hard-lg backdrop:bg-navy/40"
    >
      <h2 id={titleId} className="mb-4 text-title">
        {title}
      </h2>
      {children}
    </dialog>
  );
}

/** A date field that takes Jalali (۱۴۰۵/۰۹/۰۱) or ISO dates and reports ISO. */
export function DateInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: IsoDate;
  onChange: (value: IsoDate) => void;
}) {
  const [text, setText] = useState(() => formatDateInput(value));
  const [invalid, setInvalid] = useState(false);
  // When the date changes from outside, the field shows it (adjusted during render, no effect).
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(formatDateInput(value));
    setInvalid(false);
  }
  const commit = () => {
    const parsed = parseDateInput(text);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed !== value) onChange(parsed);
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-navy">
        {label}
      </label>
      <input
        id={id}
        dir="ltr"
        inputMode="numeric"
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className={`h-11 w-36 border-2 bg-surface px-3 text-end text-body-strong tabular-nums text-navy focus-visible:outline-2 focus-visible:outline-focus ${
          invalid ? 'border-red-dark' : 'border-navy'
        }`}
      />
      {invalid && <p className="text-meta text-red-dark">{t('ui.date.invalid')}</p>}
    </div>
  );
}

export function Loading() {
  return <p className="text-body text-ink-muted">{t('app.loading')}</p>;
}

/** An API failure in words people understand; 403 is "not allowed", not an error. */
export function ErrorNote({ error }: { error: unknown }) {
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <p role="alert" className="border-2 border-red-dark px-4 py-3 text-body-strong text-red-dark">
      {forbidden ? t('ui.error.forbidden') : t('ui.error.generic')}
    </p>
  );
}

/** A labelled single-line text input or select in the design-system frame. */
export function Select({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-navy">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 border-2 border-navy bg-surface px-3 text-body-strong text-navy focus-visible:outline-2 focus-visible:outline-focus"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A reason box and confirm/cancel buttons, for every audited change made from the UI. */
export function ReasonForm({
  submitLabel,
  onSubmit,
  onCancel,
  primary = true,
}: {
  submitLabel: string;
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
  primary?: boolean;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason.trim()) return;
        setBusy(true);
        setError(null);
        onSubmit(reason.trim())
          .catch(setError)
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-label text-navy">
          {t('ui.reason')}
        </label>
        <textarea
          id={id}
          required
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="border-2 border-navy bg-surface px-3 py-2 text-body text-navy focus-visible:outline-2 focus-visible:outline-focus"
        />
      </div>
      {error !== null && <ErrorNote error={error} />}
      <div className="flex gap-3">
        <Button
          type="submit"
          variant={primary ? 'primary' : 'secondary'}
          disabled={busy || !reason.trim()}
        >
          {submitLabel}
        </Button>
        <Button onClick={onCancel}>{t('ui.cancel')}</Button>
      </div>
    </form>
  );
}

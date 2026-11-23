import type { InputHTMLAttributes } from 'react';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  /** One line under the input: help text, or an error when `invalid`. */
  hint?: string | undefined;
  invalid?: boolean;
}

/** Design-system Field: label above, 2px navy frame, square corners, one hint line below. */
export function Field({ id, label, hint, invalid = false, ...input }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-navy">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
        className={`h-11 border-2 bg-surface px-3 text-body-strong text-navy outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
          invalid ? 'border-red-dark' : 'border-navy'
        }`}
        {...input}
      />
      {hint && (
        <p id={hintId} className={`text-meta ${invalid ? 'text-red-dark' : 'text-ink-muted'}`}>
          {hint}
        </p>
      )}
    </div>
  );
}

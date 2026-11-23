import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` is the single red action of a view (design system). */
  variant?: Variant;
}

const variants: Record<Variant, string> = {
  primary:
    'border-navy bg-red text-on-red shadow-hard-sm hover:bg-red-dark active:shadow-none disabled:bg-red-dark',
  secondary: 'border-navy bg-surface text-navy hover:bg-surface-cream',
  ghost: 'border-transparent bg-transparent text-red-dark hover:underline underline-offset-4',
};

/** Design-system Button: the label is a verb that says exactly what happens. */
export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex h-11 items-center gap-2 border-2 px-4 text-body-strong font-black disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

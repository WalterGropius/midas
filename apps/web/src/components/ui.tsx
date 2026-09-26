'use client';

import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

export function Card({
  title,
  right,
  children,
  className,
  pad = true,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={cx('rounded-lg border border-line bg-surface min-w-0', className)}>
      {(title || right) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-line px-3 py-2">
          <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">{title}</h2>
          {right && <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">{right}</div>}
        </header>
      )}
      <div className={pad ? 'p-3' : undefined}>{children}</div>
    </section>
  );
}

type Variant = 'default' | 'primary' | 'danger' | 'ghost';

export function Button({
  variant = 'default',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 whitespace-nowrap';
  const sizes = size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]';
  const variants: Record<Variant, string> = {
    default: 'border-line-strong bg-surface-2 text-ink hover:border-muted',
    primary: 'border-accent bg-accent text-accent-ink hover:brightness-110',
    danger: 'border-crit/60 bg-transparent text-crit hover:bg-crit/10',
    ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink',
  };
  return <button type="button" className={cx(base, sizes, variants[variant], className)} {...rest} />;
}

/** Label + value; values use proportional sans figures (they stand alone). */
export function Stat({
  label,
  value,
  sub,
  valueClass,
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  valueClass?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div className={cx('truncate text-base font-semibold leading-snug', valueClass)}>{value}</div>
      {sub && <div className="truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function StatTile(props: Parameters<typeof Stat>[0]) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <Stat {...props} />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line px-4 py-6 text-center">
      <div className="text-[13px] text-ink-2">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-prose text-xs text-muted">{children}</div>}
    </div>
  );
}

export function ErrorText({ error, onClose }: { error: string | null | undefined; onClose?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md border border-crit/40 bg-crit/10 px-2.5 py-1.5 text-xs text-crit">
      <span aria-hidden>⚠</span>
      <span className="min-w-0 flex-1 break-words">{error}</span>
      {onClose && (
        <button type="button" className="text-crit/80 hover:text-crit" onClick={onClose} aria-label="Dismiss error">
          ×
        </button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map(t => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] transition-colors',
            t.id === value ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink-2'
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="num ml-1.5 text-[11px] text-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line bg-bg p-0.5">
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          onClick={() => onChange(o.id)}
          className={cx(
            'rounded px-2 py-0.5 text-xs transition-colors',
            o.id === value ? 'bg-surface-2 text-ink' : 'text-muted hover:text-ink-2'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded border border-line px-1.5 py-px font-mono text-[10.5px] uppercase tracking-wide text-ink-2',
        className
      )}
    >
      {children}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-md border border-line-strong bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none';

/** A short text that expands on click (rationales, mutations, instructions). */
export function Expandable({ text, n = 140, className }: { text: string; n?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="text-muted">—</span>;
  if (text.length <= n) return <span className={cx('whitespace-pre-wrap break-words', className)}>{text}</span>;
  return (
    <span className={cx('whitespace-pre-wrap break-words', className)}>
      {open ? text : `${text.slice(0, n)}…`}{' '}
      <button type="button" className="text-accent hover:underline" onClick={() => setOpen(!open)}>
        {open ? 'less' : 'more'}
      </button>
    </span>
  );
}

/** Horizontal scroll container for wide tables (page itself never scrolls sideways). */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-3 overflow-x-auto px-3">{children}</div>;
}

import { cx } from './ui';

// Status colors are reserved for state and always ship with an icon + label.
const SESSION: Record<string, { cls: string; icon: string; label: string }> = {
  running: { cls: 'text-good border-good/40', icon: '●', label: 'running' },
  paused: { cls: 'text-warn border-warn/40', icon: '❚❚', label: 'paused' },
  stopped: { cls: 'text-muted border-line-strong', icon: '■', label: 'stopped' },
  killed: { cls: 'text-crit border-crit/50', icon: '✕', label: 'killed' },
  pending_approval: { cls: 'text-serious border-serious/40', icon: '◷', label: 'awaiting approval' },
  archived: { cls: 'text-muted border-line', icon: '▣', label: 'archived' },
};

export function SessionStatusBadge({ status, title }: { status: string; title?: string }) {
  const s = SESSION[status] ?? { cls: 'text-ink-2 border-line', icon: '•', label: status };
  return (
    <span
      title={title}
      className={cx('inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[10.5px] uppercase tracking-wide', s.cls)}
    >
      <span aria-hidden className="text-[9px]">
        {s.icon}
      </span>
      {s.label}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: string }) {
  const live = mode === 'live';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[10.5px] uppercase tracking-wide',
        live ? 'border-serious/60 text-serious' : 'border-line text-ink-2'
      )}
      title={live ? 'Real money on Polymarket' : 'Simulated fills, no money at risk'}
    >
      <span aria-hidden>{live ? '$' : '◌'}</span>
      {live ? 'live' : 'paper'}
    </span>
  );
}

const LEVEL: Record<string, string> = {
  debug: 'text-muted',
  info: 'text-ink-2',
  warn: 'text-warn',
  error: 'text-crit',
};

export function LevelTag({ level }: { level: string }) {
  const icon = level === 'error' ? '✕' : level === 'warn' ? '▲' : '·';
  return (
    <span className={cx('inline-flex w-12 shrink-0 items-center gap-1 font-mono text-[10.5px] uppercase', LEVEL[level] ?? 'text-ink-2')}>
      <span aria-hidden>{icon}</span>
      {level}
    </span>
  );
}

const TASK: Record<string, string> = {
  blocked: 'text-muted',
  pending: 'text-ink-2',
  running: 'text-ink',
  done: 'text-good',
  failed: 'text-crit',
  cancelled: 'text-muted',
};

export function TaskStatus({ status }: { status: string }) {
  return <span className={cx('font-mono text-[11px] uppercase', TASK[status] ?? 'text-ink-2')}>{status}</span>;
}

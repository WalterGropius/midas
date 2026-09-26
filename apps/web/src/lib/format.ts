import type { Timestamp } from 'spacetimedb';

const MINUS = '−';

export function tsMs(ts: Timestamp): number {
  return Number(ts.microsSinceUnixEpoch / 1000n);
}

function fin(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** $1,234.56 — compacts above $100k. */
export function usd(n: number | undefined, digits = 2): string {
  if (!fin(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? MINUS : '';
  if (abs >= 100_000) return `${sign}$${compact(abs)}`;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function signedUsd(n: number | undefined, digits = 2): string {
  if (!fin(n)) return '—';
  return n > 0 ? `+${usd(n, digits)}` : usd(n, digits);
}

/** Small money amounts such as LLM cost: $0.0042 */
export function usdFine(n: number | undefined): string {
  if (!fin(n)) return '—';
  if (Math.abs(n) >= 1) return usd(n);
  return `$${n.toFixed(n === 0 ? 2 : 4)}`;
}

export function compact(n: number | undefined): string {
  if (!fin(n)) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function int(n: number | undefined): string {
  if (!fin(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/** fraction → percent: 0.123 → 12.3% */
export function pct(x: number | undefined, digits = 1): string {
  if (!fin(x)) return '—';
  const s = (Math.abs(x) * 100).toFixed(digits);
  return `${x < 0 ? MINUS : ''}${s}%`;
}

export function signedPct(x: number | undefined, digits = 1): string {
  if (!fin(x)) return '—';
  return x > 0 ? `+${pct(x, digits)}` : pct(x, digits);
}

/** probability delta → points: 0.034 → +3.4 pts */
export function points(x: number | undefined, digits = 1): string {
  if (!fin(x)) return '—';
  const s = (Math.abs(x) * 100).toFixed(digits);
  return `${x > 0 ? '+' : x < 0 ? MINUS : '±'}${s} pts`;
}

/** probability / price → cents: 0.534 → 53.4¢ */
export function cents(p: number | undefined, digits = 1): string {
  if (!fin(p)) return '—';
  return `${(p * 100).toFixed(digits)}¢`;
}

export function fixed(n: number | undefined, digits = 3): string {
  if (!fin(n)) return '—';
  return n.toFixed(digits);
}

export function relTime(ms: number, now: number): string {
  const d = now - ms;
  const abs = Math.abs(d);
  const fut = d < 0;
  const s = Math.round(abs / 1000);
  let out: string;
  if (s < 5) return 'just now';
  if (s < 60) out = `${s}s`;
  else if (s < 3600) out = `${Math.round(s / 60)}m`;
  else if (s < 86_400) out = `${Math.round(s / 360) / 10}h`.replace('.0h', 'h');
  else out = `${Math.round(s / 8640) / 10}d`.replace('.0d', 'd');
  return fut ? `in ${out}` : `${out} ago`;
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function dateOnly(v: string | number): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return typeof v === 'string' && v ? v : '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function shortHex(hex: string, n = 10): string {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  return h.length > n ? `${h.slice(0, n)}…` : h;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function pnlClass(n: number | undefined): string {
  if (!fin(n) || Math.abs(n) < 1e-9) return 'text-ink-2';
  return n > 0 ? 'text-pos' : 'text-neg';
}

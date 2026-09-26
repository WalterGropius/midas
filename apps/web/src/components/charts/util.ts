'use client';

import { useEffect, useState } from 'react';

/** Track an element's content width (charts render to the pixel). Returns a callback ref. */
export function useWidth<T extends HTMLElement>(fallback = 600) {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, fallback]);
  return [setEl, width] as const;
}

/** Clean, human tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** Domain padded out to the nearest ticks so marks never touch the frame. */
export function niceDomain(min: number, max: number, count = 4): [number, number] {
  const t = niceTicks(min, max, count);
  if (t.length < 2) return [min, max];
  const step = t[1] - t[0];
  const lo = t[0] > min ? t[0] - step : t[0];
  const hi = t[t.length - 1] < max ? t[t.length - 1] + step : t[t.length - 1];
  return [lo, hi];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STEPS = [MIN, 5 * MIN, 15 * MIN, 30 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

export function timeTicks(t0: number, t1: number, count = 5): { ticks: number[]; step: number } {
  const span = Math.max(1, t1 - t0);
  const step = STEPS.find(s => span / s <= count) ?? STEPS[STEPS.length - 1];
  // align to local midnight for day-sized steps, to the step otherwise
  const offset = step >= DAY ? new Date(t0).getTimezoneOffset() * MIN : 0;
  const start = Math.ceil((t0 - offset) / step) * step + offset;
  const ticks: number[] = [];
  for (let t = start; t <= t1; t += step) ticks.push(t);
  return { ticks, step };
}

export function formatTimeTick(t: number, step: number): string {
  const d = new Date(t);
  if (step >= DAY) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatTooltipTime(t: number): string {
  return new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function linePath(pts: { x: number; y: number }[]): string {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');
}

/** Index of the element in a sorted array closest to `t`. */
export function nearestIndex(sorted: number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - t) <= Math.abs(sorted[lo] - t)) return lo - 1;
  return lo;
}

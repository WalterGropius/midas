'use client';

import { linePath, useWidth } from './util';

/** Trend inside a stat tile: one series (slot 1), wash, end dot. No axes. */
export function Sparkline({
  points,
  height = 36,
  baseline,
  ariaLabel,
}: {
  points: { t: number; v: number }[];
  height?: number;
  /** optional reference value drawn as a hairline (e.g. bankroll) */
  baseline?: number;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(200);
  if (points.length < 2) {
    return (
      <div ref={ref} style={{ height }} className="flex items-center text-[11px] text-muted">
        {points.length === 0 ? 'no equity points yet' : 'collecting…'}
      </div>
    );
  }
  const pad = 5;
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const vals = points.map(p => p.v);
  if (baseline !== undefined) vals.push(baseline);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-9) (lo -= 1), (hi += 1);
  const sx = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (width - pad * 2);
  const sy = (v: number) => pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2);
  const pts = points.map(p => ({ x: sx(p.t), y: sy(p.v) }));
  const end = pts[pts.length - 1];
  return (
    <div ref={ref} style={{ height }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
        {baseline !== undefined && (
          <line x1={pad} x2={width - pad} y1={sy(baseline)} y2={sy(baseline)} stroke="var(--line-strong)" strokeWidth={1} />
        )}
        <path d={`${linePath(pts)}L${end.x},${height}L${pts[0].x},${height}Z`} fill="var(--s1)" fillOpacity={0.1} />
        <path d={linePath(pts)} fill="none" stroke="var(--s1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={end.x} cy={end.y} r={3.5} fill="var(--s1)" stroke="var(--surface)" strokeWidth={2} />
      </svg>
    </div>
  );
}

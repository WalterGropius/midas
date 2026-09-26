'use client';

import { useState } from 'react';
import { Segmented } from '../ui';
import type { TableView } from './time-chart';
import { formatTimeTick, niceDomain, niceTicks, timeTicks, useWidth } from './util';

export interface Bar {
  /** bucket start (ms) */
  t: number;
  v: number;
  /** extra tooltip rows: [value, label] */
  tip?: [string, string][];
}

const M = { top: 10, right: 12, bottom: 24, left: 46 };

/** Time-bucketed columns (one series, slot 1). Each column is its own hit target. */
export function BarChart({
  bars,
  bucketMs,
  t0,
  t1,
  height = 180,
  yFormat,
  valueLabel,
  ariaLabel,
  table,
}: {
  bars: Bar[];
  bucketMs: number;
  t0: number;
  t1: number;
  height?: number;
  yFormat: (v: number) => string;
  valueLabel: string;
  ariaLabel: string;
  table?: TableView;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const iw = Math.max(40, width - M.left - M.right);
  const ih = height - M.top - M.bottom;
  const n = Math.max(1, Math.round((t1 - t0) / bucketMs));
  const slot = iw / n;
  const bw = Math.max(1, Math.min(24, slot - 2)); // ≤24px, 2px surface gap
  const max = Math.max(0, ...bars.map(b => b.v));
  const [, y1] = niceDomain(0, max || 1, 4);
  const sy = (v: number) => M.top + (1 - v / y1) * ih;
  const sx = (t: number) => M.left + ((t - t0) / (t1 - t0)) * iw;
  const bottom = M.top + ih;
  const { ticks, step } = timeTicks(t0, t1, Math.max(2, Math.floor(iw / 80)));
  const hovered = hover !== null ? bars[hover] : undefined;

  return (
    <div className="min-w-0">
      {table && (
        <div className="mb-1.5 flex justify-end">
          <Segmented
            label="View"
            options={[
              { id: 'chart', label: 'chart' },
              { id: 'table', label: 'table' },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      )}
      {view === 'table' && table ? (
        <div className="overflow-auto rounded border border-line" style={{ maxHeight: 260 }}>
          <table className="tbl">
            <thead className="sticky top-0 bg-surface">
              <tr>
                {table.head.map((h, i) => (
                  <th key={h} className={i > 0 ? 'r' : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className={j > 0 ? 'num r' : 'num text-ink-2'}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative" style={{ height }}>
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
            {niceTicks(0, y1, 4).map(v => (
              <g key={v}>
                <line x1={M.left} x2={M.left + iw} y1={sy(v)} y2={sy(v)} stroke="var(--grid)" strokeWidth={1} />
                <text x={M.left - 6} y={sy(v)} dy="0.32em" textAnchor="end" className="num" fontSize={10.5} fill="var(--muted)">
                  {yFormat(v)}
                </text>
              </g>
            ))}
            {ticks.map(t => (
              <text key={t} x={sx(t)} y={bottom + 15} textAnchor="middle" className="num" fontSize={10.5} fill="var(--muted)">
                {formatTimeTick(t, step)}
              </text>
            ))}
            {bars.map((b, i) => {
              const cx = sx(b.t + bucketMs / 2);
              const top = sy(b.v);
              const h = bottom - top;
              const r = Math.min(4, bw / 2, h);
              const x = cx - bw / 2;
              // 4px rounded data-end, square at the baseline
              const d =
                h <= 0
                  ? ''
                  : `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${bottom}Z`;
              return (
                <g
                  key={b.t}
                  tabIndex={0}
                  role="img"
                  aria-label={`${formatTimeTick(b.t, 3_600_000)} ${valueLabel} ${yFormat(b.v)}`}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="outline-none"
                >
                  <rect x={cx - slot / 2} y={M.top} width={slot} height={ih} fill="transparent" />
                  {d && <path d={d} fill="var(--s1)" fillOpacity={hover === null || hover === i ? 1 : 0.55} />}
                </g>
              );
            })}
            <line x1={M.left} x2={M.left + iw} y1={bottom} y2={bottom} stroke="var(--axis)" strokeWidth={1} />
          </svg>
          {hovered && (
            <div
              className="pointer-events-none absolute top-1 z-10 w-[190px] rounded-md border border-line-strong bg-surface-2/95 px-2.5 py-2 text-[11px] shadow-lg"
              style={{ left: Math.min(Math.max(0, sx(hovered.t) + 12), Math.max(0, width - 196)) }}
            >
              <div className="num mb-1 text-muted">
                {new Date(hovered.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
              </div>
              <div className="flex gap-2">
                <span className="num font-semibold text-ink">{yFormat(hovered.v)}</span>
                <span className="text-muted">{valueLabel}</span>
              </div>
              {hovered.tip?.map(([v, l]) => (
                <div key={l} className="flex gap-2">
                  <span className="num font-semibold text-ink">{v}</span>
                  <span className="text-muted">{l}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

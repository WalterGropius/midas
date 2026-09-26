'use client';

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Segmented } from '../ui';
import { formatTimeTick, formatTooltipTime, linePath, nearestIndex, niceDomain, niceTicks, timeTicks, useWidth } from './util';

export interface TPoint {
  t: number;
  v: number;
}
export interface TSeries {
  id: string;
  label: string;
  /** CSS color, e.g. 'var(--s1)' */
  color: string;
  points: TPoint[];
  dashed?: boolean;
  area?: boolean;
}
export interface TBand {
  id: string;
  label: string;
  color: string;
  points: { t: number; lo: number; hi: number }[];
}
export interface TMarker {
  t: number;
  dir: 'up' | 'down';
  label: string;
}
export interface TableView {
  head: string[];
  rows: (string | number)[][];
}

// Signal markers: polarity carried by glyph direction AND hue (slots 3 / 2,
// which validate all-pairs against the slot-1 price line in both modes).
const MARK_UP = 'var(--s3)';
const MARK_DOWN = 'var(--s2)';

interface Props {
  series: TSeries[];
  bands?: TBand[];
  markers?: TMarker[];
  refLines?: { v: number; label: string }[];
  height?: number;
  yFormat: (v: number) => string;
  /** hard limits for the y domain, e.g. [0, 1] for probabilities */
  clamp?: [number, number];
  xDomain?: [number, number];
  now?: number;
  ariaLabel: string;
  table?: TableView;
}

const M = { top: 12, right: 58, bottom: 24, left: 46 };

interface Geo {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  iw: number;
  ih: number;
  sx: (t: number) => number;
  sy: (v: number) => number;
  /** sorted union of every data timestamp: the crosshair snaps to these */
  times: number[];
}

export function TimeChart({
  series,
  bands = [],
  markers = [],
  refLines = [],
  height = 200,
  yFormat,
  clamp,
  xDomain,
  now,
  ariaLabel,
  table,
}: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');

  const geo = useMemo((): Geo | null => {
    const ts: number[] = [];
    const vs: number[] = [];
    for (const s of series) for (const p of s.points) (ts.push(p.t), vs.push(p.v));
    for (const b of bands) for (const p of b.points) (ts.push(p.t), vs.push(p.lo, p.hi));
    for (const r of refLines) vs.push(r.v);
    if (ts.length === 0) return null;
    let x0 = xDomain?.[0] ?? Math.min(...ts);
    let x1 = xDomain?.[1] ?? Math.max(...ts);
    if (now !== undefined && !xDomain) x1 = Math.max(x1, now);
    if (x1 - x0 < 60_000) (x0 -= 30_000), (x1 += 30_000);
    let [y0, y1] = niceDomain(Math.min(...vs), Math.max(...vs), 4);
    if (clamp) (y0 = Math.max(clamp[0], y0)), (y1 = Math.min(clamp[1], y1));
    if (y1 <= y0) y1 = y0 + 1e-6;
    const iw = Math.max(40, width - M.left - M.right);
    const ih = Math.max(40, height - M.top - M.bottom);
    const sx = (t: number) => M.left + ((t - x0) / (x1 - x0)) * iw;
    const sy = (v: number) => M.top + (1 - (v - y0) / (y1 - y0)) * ih;
    const times = [...new Set(ts)].sort((a, b) => a - b);
    return { x0, x1, y0, y1, iw, ih, sx, sy, times };
  }, [series, bands, refLines, xDomain, now, clamp, width, height]);

  const hasData = geo !== null;
  const legendItems = [
    ...series.map(s => ({ key: s.id, label: s.label, kind: s.dashed ? ('dash' as const) : ('line' as const), color: s.color })),
    ...bands.map(b => ({ key: b.id, label: b.label, kind: 'band' as const, color: b.color })),
    ...(markers.some(m => m.dir === 'up') ? [{ key: 'mu', label: 'signal ▲ up', kind: 'up' as const, color: MARK_UP }] : []),
    ...(markers.some(m => m.dir === 'down') ? [{ key: 'md', label: 'signal ▼ down', kind: 'down' as const, color: MARK_DOWN }] : []),
  ];

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = geo.x0 + ((x - M.left) / geo.iw) * (geo.x1 - geo.x0);
    const i = nearestIndex(geo.times, t);
    setHoverT(i >= 0 ? geo.times[i] : null);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!geo || geo.times.length === 0) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = hoverT === null ? geo.times.length - 1 : nearestIndex(geo.times, hoverT);
    const next = Math.max(0, Math.min(geo.times.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    setHoverT(geo.times[next]);
  };

  return (
    <div className="min-w-0">
      {(legendItems.length > 1 || table) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-2">
          {legendItems.length > 1 && legendItems.map(l => <LegendKey key={l.key} label={l.label} kind={l.kind} color={l.color} />)}
          {table && (
            <div className="ml-auto">
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
        </div>
      )}
      {view === 'table' && table ? (
        <ChartTable table={table} height={height} />
      ) : (
        <div ref={ref} className="relative" style={{ height }}>
          {!hasData ? (
            <div className="flex h-full items-center justify-center rounded border border-dashed border-line text-xs text-muted">
              no data in this window yet
            </div>
          ) : (
            <Plot
              geo={geo}
              width={width}
              height={height}
              series={series}
              bands={bands}
              markers={markers}
              refLines={refLines}
              yFormat={yFormat}
              now={now}
              hoverT={hoverT}
              ariaLabel={ariaLabel}
              onMove={onMove}
              onLeave={() => setHoverT(null)}
              onKey={onKey}
            />
          )}
          {geo && hoverT !== null && (
            <Tooltip geo={geo} width={width} t={hoverT} series={series} bands={bands} markers={markers} yFormat={yFormat} />
          )}
        </div>
      )}
    </div>
  );
}

function Plot({
  geo,
  width,
  height,
  series,
  bands,
  markers,
  refLines,
  yFormat,
  now,
  hoverT,
  ariaLabel,
  onMove,
  onLeave,
  onKey,
}: {
  geo: Geo;
  width: number;
  height: number;
  series: TSeries[];
  bands: TBand[];
  markers: TMarker[];
  refLines: { v: number; label: string }[];
  yFormat: (v: number) => string;
  now?: number;
  hoverT: number | null;
  ariaLabel: string;
  onMove: (e: PointerEvent<SVGSVGElement>) => void;
  onLeave: () => void;
  onKey: (e: KeyboardEvent<SVGSVGElement>) => void;
}) {
  const { sx, sy, x0, x1, y0, y1, iw, ih } = geo;
  const yTicks = niceTicks(y0, y1, 4).filter(v => v >= y0 - 1e-9 && v <= y1 + 1e-9);
  const { ticks: xTicks, step } = timeTicks(x0, x1, Math.max(2, Math.floor(iw / 90)));
  const bottom = M.top + ih;
  const main = series[0];
  const last = main?.points[main.points.length - 1];

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel}
      tabIndex={0}
      className="block touch-none select-none outline-none focus-visible:outline-2 focus-visible:outline-accent"
      onPointerMove={onMove}
      onPointerDown={onMove}
      onPointerLeave={onLeave}
      onBlur={onLeave}
      onKeyDown={onKey}
    >
      {/* grid + axes: hairline, solid, recessive */}
      {yTicks.map(v => (
        <g key={`y${v}`}>
          <line x1={M.left} x2={M.left + iw} y1={sy(v)} y2={sy(v)} stroke="var(--grid)" strokeWidth={1} />
          <text x={M.left - 6} y={sy(v)} dy="0.32em" textAnchor="end" className="num" fontSize={10.5} fill="var(--muted)">
            {yFormat(v)}
          </text>
        </g>
      ))}
      <line x1={M.left} x2={M.left + iw} y1={bottom} y2={bottom} stroke="var(--axis)" strokeWidth={1} />
      {xTicks.map(t => (
        <text key={`x${t}`} x={sx(t)} y={bottom + 15} textAnchor="middle" className="num" fontSize={10.5} fill="var(--muted)">
          {formatTimeTick(t, step)}
        </text>
      ))}

      {refLines.map(r =>
        r.v >= y0 && r.v <= y1 ? (
          <g key={`r${r.label}`}>
            <line x1={M.left} x2={M.left + iw} y1={sy(r.v)} y2={sy(r.v)} stroke="var(--line-strong)" strokeWidth={1} />
            <text x={M.left + 4} y={sy(r.v) - 4} fontSize={10} fill="var(--muted)">
              {r.label}
            </text>
          </g>
        ) : null
      )}

      {now !== undefined && now >= x0 && now <= x1 && (
        <g>
          <line x1={sx(now)} x2={sx(now)} y1={M.top} y2={bottom} stroke="var(--line-strong)" strokeWidth={1} />
          <text x={sx(now) + 3} y={M.top + 8} fontSize={10} fill="var(--muted)">
            now
          </text>
        </g>
      )}

      {bands.map(b => {
        if (b.points.length < 2) return null;
        const up = b.points.map(p => ({ x: sx(p.t), y: sy(p.hi) }));
        const lo = [...b.points].reverse().map(p => ({ x: sx(p.t), y: sy(p.lo) }));
        return <path key={b.id} d={`${linePath(up)}${linePath(lo).replace(/^M/, 'L')}Z`} fill={b.color} fillOpacity={0.12} />;
      })}

      {series.map(s => {
        if (s.points.length === 0) return null;
        const pts = s.points.map(p => ({ x: sx(p.t), y: sy(p.v) }));
        return (
          <g key={s.id}>
            {s.area && pts.length > 1 && (
              <path
                d={`${linePath(pts)}L${pts[pts.length - 1].x.toFixed(1)},${bottom}L${pts[0].x.toFixed(1)},${bottom}Z`}
                fill={s.color}
                fillOpacity={0.1}
              />
            )}
            <path
              d={linePath(pts)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={s.dashed ? '4 3' : undefined}
            />
          </g>
        );
      })}

      {markers.map((m, i) => {
        if (m.t < x0 || m.t > x1) return null;
        const x = sx(m.t);
        const color = m.dir === 'up' ? MARK_UP : MARK_DOWN;
        const tri = m.dir === 'up' ? `M${x},${M.top - 1}l5,8h-10z` : `M${x},${M.top + 7}l5,-8h-10z`;
        return (
          <g key={`m${i}`}>
            <line x1={x} x2={x} y1={M.top + 8} y2={bottom} stroke={color} strokeOpacity={0.55} strokeWidth={1} />
            <path d={tri} fill={color} stroke="var(--surface)" strokeWidth={2} paintOrder="stroke" />
          </g>
        );
      })}

      {main && last && (
        <g>
          <circle cx={sx(last.t)} cy={sy(last.v)} r={4} fill={main.color} stroke="var(--surface)" strokeWidth={2} />
          <text x={M.left + iw + 8} y={sy(last.v)} dy="0.32em" className="num" fontSize={11} fill="var(--ink-2)">
            {yFormat(last.v)}
          </text>
        </g>
      )}

      {hoverT !== null && (
        <g pointerEvents="none">
          <line x1={sx(hoverT)} x2={sx(hoverT)} y1={M.top} y2={bottom} stroke="var(--muted)" strokeWidth={1} />
          {series.map(s => {
            const p = nearestPoint(s.points, hoverT, x1 - x0);
            return p ? (
              <circle key={s.id} cx={sx(p.t)} cy={sy(p.v)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            ) : null;
          })}
        </g>
      )}
    </svg>
  );
}

function nearestPoint<T extends { t: number }>(pts: T[], t: number, span: number): T | undefined {
  if (pts.length === 0) return undefined;
  const i = nearestIndex(
    pts.map(p => p.t),
    t
  );
  const p = pts[i];
  return Math.abs(p.t - t) <= Math.max(span * 0.03, 90_000) ? p : undefined;
}

function Tooltip({
  geo,
  width,
  t,
  series,
  bands,
  markers,
  yFormat,
}: {
  geo: Geo;
  width: number;
  t: number;
  series: TSeries[];
  bands: TBand[];
  markers: TMarker[];
  yFormat: (v: number) => string;
}) {
  const span = geo.x1 - geo.x0;
  const x = geo.sx(t);
  const left = x > width - 220 ? Math.max(0, x - 212) : x + 12;
  const near = markers.filter(m => Math.abs(m.t - t) <= Math.max(span * 0.015, 60_000)).slice(0, 3);
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 w-[200px] rounded-md border border-line-strong bg-surface-2/95 px-2.5 py-2 text-[11px] shadow-lg"
      style={{ left }}
    >
      <div className="num mb-1 text-muted">{formatTooltipTime(t)}</div>
      {series.map(s => {
        const p = nearestPoint(s.points, t, span);
        if (!p) return null;
        return (
          <div key={s.id} className="flex items-center gap-2">
            <svg width={12} height={6} aria-hidden>
              <line x1={0} x2={12} y1={3} y2={3} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '3 2' : undefined} />
            </svg>
            <span className="num font-semibold text-ink">{yFormat(p.v)}</span>
            <span className="truncate text-muted">{s.label}</span>
          </div>
        );
      })}
      {bands.map(b => {
        const p = nearestPoint(b.points, t, span);
        if (!p) return null;
        return (
          <div key={b.id} className="flex items-center gap-2">
            <span aria-hidden className="inline-block h-2 w-3 rounded-sm" style={{ background: b.color, opacity: 0.35 }} />
            <span className="num font-semibold text-ink">
              {yFormat(p.lo)}–{yFormat(p.hi)}
            </span>
            <span className="truncate text-muted">{b.label}</span>
          </div>
        );
      })}
      {near.map((m, i) => (
        <div key={i} className="mt-1 border-t border-line pt-1 text-ink-2">
          <span aria-hidden style={{ color: m.dir === 'up' ? MARK_UP : MARK_DOWN }}>
            {m.dir === 'up' ? '▲' : '▼'}
          </span>{' '}
          {m.label}
        </div>
      ))}
    </div>
  );
}

function LegendKey({ label, kind, color }: { label: string; kind: 'line' | 'dash' | 'band' | 'up' | 'down'; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {kind === 'line' || kind === 'dash' ? (
        <svg width={14} height={6} aria-hidden>
          <line x1={0} x2={14} y1={3} y2={3} stroke={color} strokeWidth={2} strokeDasharray={kind === 'dash' ? '4 3' : undefined} />
        </svg>
      ) : kind === 'band' ? (
        <span aria-hidden className="inline-block h-2.5 w-3.5 rounded-sm" style={{ background: color, opacity: 0.3 }} />
      ) : (
        <span aria-hidden style={{ color }}>
          {kind === 'up' ? '▲' : '▼'}
        </span>
      )}
      {label.replace(/^signal [▲▼] /, 'signal ')}
    </span>
  );
}

function ChartTable({ table, height }: { table: TableView; height: number }) {
  return (
    <div className="overflow-auto rounded border border-line" style={{ maxHeight: Math.max(height, 220) }}>
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
  );
}

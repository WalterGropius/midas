'use client';

import { useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import type { Decision } from '@midas/stdb-bindings/types';
import { TimeChart } from '@/components/charts/time-chart';
import { Card, Empty, Pill, Segmented, TableWrap } from '@/components/ui';
import { cents, dateTime, fixed, int, pnlClass, points, relTime, signedUsd, truncate, tsMs, usd } from '@/lib/format';
import { useCutoff, useNow } from '@/lib/stdb';
import type { SessionCtx } from './context';

const RANGES = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, all: null } as const;
type Range = keyof typeof RANGES;

export function OverviewTab({ ctx }: { ctx: SessionCtx }) {
  return (
    <div className="space-y-4">
      <EquityCard ctx={ctx} />
      <PositionsCard ctx={ctx} />
      <div className="grid gap-4 xl:grid-cols-2">
        <OrdersCard ctx={ctx} />
        <DecisionsCard ctx={ctx} />
      </div>
    </div>
  );
}

function EquityCard({ ctx }: { ctx: SessionCtx }) {
  const [range, setRange] = useState<Range>('24h');
  const cutoff = useCutoff(RANGES[range], range === '24h' ? 10 * 60_000 : 3_600_000);
  const id = ctx.session.id;
  const q = useMemo(() => tables.equityPoint.where(r => r.sessionId.eq(id).and(r.ts.gte(cutoff))), [id, cutoff]);
  const [rows, ready] = useTable(q);
  const pts = useMemo(() => [...rows].sort((a, b) => Number(a.ts.microsSinceUnixEpoch - b.ts.microsSinceUnixEpoch)), [rows]);

  return (
    <Card
      title="Equity"
      right={
        <Segmented
          label="Range"
          options={(Object.keys(RANGES) as Range[]).map(r => ({ id: r, label: r }))}
          value={range}
          onChange={setRange}
        />
      }
    >
      <div className={ready ? undefined : 'opacity-50'}>
        <TimeChart
          ariaLabel={`Equity of ${ctx.session.name}, ${range}`}
          height={220}
          yFormat={v => usd(v, 0)}
          refLines={[{ v: ctx.session.bankrollUsd, label: 'bankroll' }]}
          series={[{ id: 'equity', label: 'equity', color: 'var(--s1)', area: true, points: pts.map(p => ({ t: tsMs(p.ts), v: p.equityUsd })) }]}
          table={{
            head: ['time', 'equity', 'cash', 'exposure'],
            rows: [...pts].reverse().slice(0, 500).map(p => [dateTime(tsMs(p.ts)), usd(p.equityUsd), usd(p.cashUsd), usd(p.exposureUsd)]),
          }}
        />
      </div>
      {ready && pts.length === 0 && (
        <p className="mt-2 text-xs text-muted">The engine records an equity point every accounting pass while the session runs.</p>
      )}
    </Card>
  );
}

function PositionsCard({ ctx }: { ctx: SessionCtx }) {
  const [showClosed, setShowClosed] = useState(false);
  const id = ctx.session.id;
  const now = useNow(30_000);
  const q = useMemo(() => tables.position.where(r => r.sessionId.eq(id)), [id]);
  const [rows, ready] = useTable(q);
  const shown = rows
    .filter(p => showClosed || !p.closed)
    .sort((a, b) => Number(b.updatedAt.microsSinceUnixEpoch - a.updatedAt.microsSinceUnixEpoch));
  const open = rows.filter(p => !p.closed);
  const unreal = open.reduce((s, p) => s + p.unrealizedPnlUsd, 0);

  return (
    <Card
      title={`Positions · ${open.length} open`}
      right={
        <>
          <span className={`num ${pnlClass(unreal)}`}>unrealized {signedUsd(unreal)}</span>
          <Segmented
            label="Positions"
            options={[
              { id: 'open', label: 'open' },
              { id: 'all', label: 'incl. closed' },
            ]}
            value={showClosed ? 'all' : 'open'}
            onChange={v => setShowClosed(v === 'all')}
          />
        </>
      }
    >
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : shown.length === 0 ? (
        <Empty title="No open positions">
          Positions appear when an approved decision fills. Paper fills are simulated against the live book, fees included.
        </Empty>
      ) : (
        <TableWrap>
          <table className="tbl min-w-[900px]">
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th className="r">Shares</th>
                <th className="r">Avg</th>
                <th className="r">Mark</th>
                <th className="r">Cost</th>
                <th className="r">Unrealized</th>
                <th className="r">Realized</th>
                <th>Strategy</th>
                <th className="r">Target / stop</th>
                <th className="r">Time stop</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(p => {
                const timeStop = Number(p.timeStopMicros / 1000n);
                return (
                  <tr key={p.id.toString()} className={p.closed ? 'opacity-55' : undefined}>
                    <td className="max-w-[280px]">
                      <div className="truncate" title={ctx.label(p.conditionId)}>
                        {ctx.label(p.conditionId)}
                      </div>
                      <div className="num text-[11px] text-muted">
                        opened {relTime(tsMs(p.openedAt), now)}
                        {p.closed ? ' · closed' : ''}
                      </div>
                    </td>
                    <td>
                      <Pill>{p.outcome}</Pill>
                    </td>
                    <td className="num r">{fixed(p.shares, 2)}</td>
                    <td className="num r">{cents(p.avgPrice)}</td>
                    <td className="num r">{cents(p.markPrice)}</td>
                    <td className="num r">{usd(p.costUsd)}</td>
                    <td className={`num r ${pnlClass(p.unrealizedPnlUsd)}`}>{signedUsd(p.unrealizedPnlUsd)}</td>
                    <td className={`num r ${pnlClass(p.realizedPnlUsd)}`}>{signedUsd(p.realizedPnlUsd)}</td>
                    <td className="text-ink-2">{p.strategy || '—'}</td>
                    <td className="num r text-ink-2">
                      {p.targetPrice > 0 ? cents(p.targetPrice) : '—'} / {p.stopPrice > 0 ? cents(p.stopPrice) : '—'}
                    </td>
                    <td className="num r text-ink-2">{timeStop > 0 ? relTime(timeStop, now) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function OrdersCard({ ctx }: { ctx: SessionCtx }) {
  const id = ctx.session.id;
  const now = useNow(30_000);
  const q = useMemo(() => tables.tradeOrder.where(r => r.sessionId.eq(id)), [id]);
  const [rows, ready] = useTable(q);
  const shown = [...rows].sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch)).slice(0, 30);
  return (
    <Card title={`Orders · ${rows.length}`}>
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : shown.length === 0 ? (
        <Empty title="No orders yet">Orders are placed only after a decision passes every risk gate and the evaluator approves it.</Empty>
      ) : (
        <TableWrap>
          <table className="tbl min-w-[640px]">
            <thead>
              <tr>
                <th>When</th>
                <th>Market</th>
                <th>Order</th>
                <th className="r">Price</th>
                <th className="r">Filled</th>
                <th className="r">Fee</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(o => (
                <tr key={o.id.toString()}>
                  <td className="num whitespace-nowrap text-muted" title={dateTime(tsMs(o.createdAt))}>
                    {relTime(tsMs(o.createdAt), now)}
                  </td>
                  <td className="max-w-[200px]">
                    <div className="truncate" title={ctx.label(o.conditionId)}>
                      {ctx.label(o.conditionId)}
                    </div>
                    {o.note && <div className="truncate text-[11px] text-muted">{o.note}</div>}
                  </td>
                  <td className="whitespace-nowrap font-mono text-[12px]">
                    {o.side} {o.outcome}
                    {o.mode === 'live' && <span className="ml-1 text-serious">$</span>}
                  </td>
                  <td className="num r">{cents(o.price)}</td>
                  <td className="num r">
                    {fixed(o.filledSize, 1)}/{fixed(o.size, 1)}
                    {o.filledSize > 0 && <div className="text-[11px] text-muted">@ {cents(o.avgFillPrice)}</div>}
                  </td>
                  <td className="num r">{usd(o.feeUsd)}</td>
                  <td className="font-mono text-[11px] uppercase text-ink-2">{o.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function DecisionsCard({ ctx }: { ctx: SessionCtx }) {
  const id = ctx.session.id;
  const q = useMemo(() => tables.decision.where(r => r.sessionId.eq(id)), [id]);
  const [rows, ready] = useTable(q);
  const [filter, setFilter] = useState<'all' | 'approved' | 'rejected'>('all');
  const shown = rows
    .filter(d => filter === 'all' || d.verdict === filter)
    .sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch))
    .slice(0, 40);
  return (
    <Card
      title={`Decisions · ${rows.length}`}
      right={
        <Segmented
          label="Verdict"
          options={[
            { id: 'all', label: 'all' },
            { id: 'approved', label: 'approved' },
            { id: 'rejected', label: 'rejected' },
          ]}
          value={filter}
          onChange={setFilter}
        />
      }
    >
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : shown.length === 0 ? (
        <Empty title="No decisions yet">
          Every signal with enough edge becomes a decision: sized by Kelly, checked by the risk gates, then approved or rejected with reasons.
        </Empty>
      ) : (
        <ul className="max-h-[520px] divide-y divide-line overflow-y-auto">
          {shown.map(d => (
            <DecisionRow key={d.id.toString()} d={d} label={ctx.label(d.conditionId)} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function DecisionRow({ d, label }: { d: Decision; label: string }) {
  const [open, setOpen] = useState(false);
  const now = useNow(30_000);
  const approved = d.verdict === 'approved';
  return (
    <li className="py-2 text-xs">
      <button type="button" className="w-full text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
          <span className="font-mono uppercase text-ink">{d.action}</span>
          {d.strategy && <Pill>{d.strategy}</Pill>}
          <span className="num text-ink-2">edge {points(d.edge)}</span>
          <span className="num text-ink-2">{usd(d.sizeUsd, 0)}</span>
          <span className="num text-muted" title="independent confirmations">
            ×{int(d.confirmations)} conf
          </span>
          <span className={approved ? 'text-ink' : 'text-muted'}>
            <span aria-hidden>{approved ? '✓' : '✕'}</span> {d.verdict}
          </span>
          <span className="num ml-auto text-muted">{relTime(tsMs(d.createdAt), now)}</span>
        </div>
        <div className="mt-0.5 truncate text-muted" title={label}>
          {truncate(label, 110)}
        </div>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 rounded-md bg-bg p-2.5">
          <div className="num grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-4">
            <span className="text-muted">
              fair <span className="text-ink-2">{cents(d.fairProb)}</span>
            </span>
            <span className="text-muted">
              market <span className="text-ink-2">{cents(d.marketPrice)}</span>
            </span>
            <span className="text-muted">
              kelly <span className="text-ink-2">{fixed(d.kellyFraction, 3)}</span>
            </span>
            <span className="text-muted">
              confidence <span className="text-ink-2">{fixed(d.confidence, 2)}</span>
            </span>
          </div>
          {d.reasons.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-4 text-ink-2">
              {d.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <div className="text-muted">No reasons recorded.</div>
          )}
          <div className="num text-[10.5px] text-muted">
            {d.ref}
            {d.signalRef && ` · signal ${d.signalRef}`}
          </div>
        </div>
      )}
    </li>
  );
}

'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useTable } from 'spacetimedb/react';
import type { Timestamp } from 'spacetimedb';
import { tables } from '@midas/stdb-bindings';
import type { NewsItem, Signal } from '@midas/stdb-bindings/types';
import { Card, Empty, Expandable, Pill, Segmented, TableWrap, cx } from '@/components/ui';
import { cents, dateTime, fixed, int, points, relTime, truncate, tsMs } from '@/lib/format';
import { useNow } from '@/lib/stdb';
import type { SessionCtx } from './context';

const MAX_SIGNALS = 150;

/** Signals on any of the given markets (one OR-filtered subscription). */
export function useSignals(conditionIds: string[], since?: Timestamp) {
  const key = conditionIds.join(',');
  const q = useMemo(() => {
    if (conditionIds.length === 0) return tables.signal;
    return tables.signal.where(r => {
      const any = conditionIds.map(c => r.conditionId.eq(c)).reduce((a, b) => a.or(b));
      return since === undefined ? any : any.and(r.createdAt.gte(since));
    });
  }, [key, since]);
  const [rows, ready] = useTable(q, { enabled: conditionIds.length > 0 });
  const sorted = useMemo(
    () => [...rows].sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch)),
    [rows]
  );
  return [sorted, ready] as const;
}

/** News rows for a set of ids (the headlines behind signals). */
export function useNews(ids: bigint[]): Map<string, NewsItem> {
  const uniq = useMemo(() => [...new Set(ids.map(i => i.toString()))].sort(), [ids]);
  const key = uniq.join(',');
  const q = useMemo(() => {
    if (uniq.length === 0) return tables.newsItem;
    return tables.newsItem.where(r => uniq.map(id => r.id.eq(BigInt(id))).reduce((a, b) => a.or(b)));
  }, [key]);
  const [rows] = useTable(q, { enabled: uniq.length > 0 });
  return useMemo(() => new Map(rows.map(n => [n.id.toString(), n])), [rows]);
}

export function SignalsTab({ ctx }: { ctx: SessionCtx }) {
  const [signals, ready] = useSignals(ctx.conditionIds);
  const [layer, setLayer] = useState<'all' | 'reflex' | 'swarm' | 'pro'>('all');
  const [market, setMarket] = useState<string>('all');
  const shown = signals
    .filter(s => layer === 'all' || s.layer === layer)
    .filter(s => market === 'all' || s.conditionId === market)
    .slice(0, MAX_SIGNALS);
  const news = useNews(useMemo(() => shown.map(s => s.newsId), [shown]));

  if (ctx.conditionIds.length === 0) {
    return <Empty title="This session has no markets">Add markets in the Settings tab; signals are produced per market.</Empty>;
  }
  return (
    <Card
      title={`Signals · ${signals.length}`}
      right={
        <>
          <select
            className="max-w-[220px] rounded-md border border-line bg-bg px-2 py-0.5 text-xs text-ink-2"
            value={market}
            onChange={e => setMarket(e.target.value)}
            aria-label="Filter by market"
          >
            <option value="all">all markets</option>
            {ctx.conditionIds.map(c => (
              <option key={c} value={c}>
                {truncate(ctx.label(c), 60)}
              </option>
            ))}
          </select>
          <Segmented
            label="Layer"
            options={[
              { id: 'all', label: 'all' },
              { id: 'reflex', label: 'reflex' },
              { id: 'swarm', label: 'swarm' },
              { id: 'pro', label: 'pro' },
            ]}
            value={layer}
            onChange={setLayer}
          />
        </>
      }
    >
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : shown.length === 0 ? (
        <Empty title="No signals yet">
          The engine creates them when a relevant headline hits one of this session’s markets: reflexes judge relevance and
          direction in milliseconds, then the swarm (and, on escalation, the Pro supervisor) forecasts the reaction.
        </Empty>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map(s => (
            <SignalRow key={s.id.toString()} s={s} news={news.get(s.newsId.toString())} label={ctx.label(s.conditionId)} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function Metric({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[10.5px] text-muted">{label}</div>
      <div className="num truncate text-[12px] text-ink">{children}</div>
    </div>
  );
}

function realized(v: number | undefined) {
  return v === undefined ? <span className="text-muted">pending</span> : points(v);
}

export function SignalRow({ s, news, label, compact = false }: { s: Signal; news?: NewsItem; label: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const now = useNow(30_000);
  const edge = s.probYes - s.probMarket;
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="num w-14 shrink-0 text-muted" title={dateTime(tsMs(s.createdAt))}>
          {relTime(tsMs(s.createdAt), now)}
        </span>
        <Pill>{s.layer}</Pill>
        <span className="num font-semibold text-ink" title="expected reaction of the YES price">
          <span aria-hidden className={s.expectedDelta >= 0 ? 'text-s3' : 'text-s2'}>
            {s.expectedDelta >= 0 ? '▲' : '▼'}
          </span>{' '}
          {points(s.expectedDelta)}
        </span>
        {!compact && (
          <span className="min-w-0 flex-1 truncate text-ink-2" title={label}>
            {label}
          </span>
        )}
        <span className={cx('font-mono text-[10.5px] uppercase', s.status === 'scored' ? 'text-ink-2' : 'text-muted')}>{s.status}</span>
      </div>
      <div className="mt-1 text-[13px] leading-snug">
        {news ? (
          <>
            {news.url ? (
              <a href={news.url} target="_blank" rel="noopener noreferrer nofollow" className="text-ink hover:text-accent">
                {news.title}
              </a>
            ) : (
              <span className="text-ink">{news.title}</span>
            )}
            <span className="ml-2 text-[11px] text-muted">
              {news.source} · {relTime(tsMs(news.publishedAt), now)}
            </span>
          </>
        ) : (
          <span className="text-muted">headline #{s.newsId.toString()}</span>
        )}
      </div>
      <div className={cx('mt-2 grid gap-x-4 gap-y-1.5', compact ? 'grid-cols-3 sm:grid-cols-6' : 'grid-cols-3 sm:grid-cols-5 lg:grid-cols-9')}>
        <Metric label="q10–q90" title="80% interval of the expected move">
          {points(s.deltaQ10).replace(' pts', '')} … {points(s.deltaQ90)}
        </Metric>
        <Metric label="half-life">{fixed(s.halfLifeMin, 0)} min</Metric>
        <Metric label="blind fair / mkt" title="probYes from forecasters blind to the price, vs the market price">
          {cents(s.probYes)} / {cents(s.probMarket)}
        </Metric>
        <Metric label="fair − mkt">{points(edge)}</Metric>
        <Metric label="disagreement" title={`${s.nAgents} agents`}>
          {fixed(s.disagreement, 2)} · n{int(s.nAgents)}
        </Metric>
        <Metric label="analog prior" title="mean realized move of similar past headlines">
          {s.analogCount > 0 ? `${points(s.analogMeanDelta)} (${s.analogCount})` : '—'}
        </Metric>
        {!compact && (
          <>
            <Metric label="realized 5m">{realized(s.realizedShort)}</Metric>
            <Metric label="30m">{realized(s.realizedMid)}</Metric>
            <Metric label="2h · |err|">
              {realized(s.realizedLong)}
              {s.absError !== undefined && <span className="text-muted"> · {points(s.absError).replace('+', '')}</span>}
            </Metric>
          </>
        )}
      </div>
      <button type="button" className="mt-1.5 text-[11px] text-accent hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'hide reasoning' : `reasoning & ${s.nAgents} agent forecast${s.nAgents === 1 ? '' : 's'}`}
      </button>
      {open && <SignalDetail s={s} />}
    </li>
  );
}

function SignalDetail({ s }: { s: Signal }) {
  const q = useMemo(() => tables.agentForecast.where(r => r.signalId.eq(s.id)), [s.id]);
  const [forecasts, ready] = useTable(q);
  const [agents] = useTable(tables.agent);
  const names = useMemo(() => new Map(agents.map(a => [a.id.toString(), a])), [agents]);
  return (
    <div className="mt-2 space-y-2 rounded-md bg-bg p-3 text-xs">
      {s.rationale && (
        <div>
          <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">Rationale</div>
          <Expandable text={s.rationale} n={400} className="text-ink-2" />
        </div>
      )}
      {!ready ? (
        <div className="text-muted">loading agent forecasts…</div>
      ) : forecasts.length === 0 ? (
        <div className="text-muted">No per-agent forecasts ({s.layer === 'reflex' ? 'reflex signals come from System-1 alone' : 'not recorded'}).</div>
      ) : (
        <TableWrap>
          <table className="tbl min-w-[620px]">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="r">P(yes)</th>
                <th className="r">Δ</th>
                <th className="r">Half-life</th>
                <th className="r">Conf.</th>
                <th className="r">Brier</th>
                <th>Rationale</th>
              </tr>
            </thead>
            <tbody>
              {[...forecasts]
                .sort((a, b) => b.confidence - a.confidence)
                .map(f => {
                  const a = names.get(f.agentId.toString());
                  return (
                    <tr key={f.id.toString()}>
                      <td className="whitespace-nowrap">
                        <div className="text-ink">{a?.name ?? `agent ${f.agentId.toString()}`}</div>
                        {a && <div className="text-[10.5px] text-muted">{a.tier} · gen {a.generation}</div>}
                      </td>
                      <td className="num r">{cents(f.probYes)}</td>
                      <td className="num r">{points(f.expectedDelta)}</td>
                      <td className="num r">{fixed(f.halfLifeMin, 0)}m</td>
                      <td className="num r">{fixed(f.confidence, 2)}</td>
                      <td className="num r">{f.brier === undefined ? '—' : fixed(f.brier, 3)}</td>
                      <td className="min-w-[240px] text-ink-2">
                        <Expandable text={f.rationale} n={160} />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </div>
  );
}

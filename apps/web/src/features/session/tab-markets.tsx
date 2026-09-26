'use client';

import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import type { PathForecast, SessionMarket } from '@midas/stdb-bindings/types';
import { TimeChart, type TBand, type TMarker, type TSeries } from '@/components/charts/time-chart';
import { Card, Empty, Pill } from '@/components/ui';
import { cents, compact, dateOnly, dateTime, pct, points, relTime, tsMs } from '@/lib/format';
import { useCutoff, useNow } from '@/lib/stdb';
import type { SessionCtx } from './context';
import { SignalRow, useNews, useSignals } from './tab-signals';

const WINDOW_MS = 24 * 3_600_000;

export function MarketsTab({ ctx }: { ctx: SessionCtx }) {
  const list = [...ctx.sessionMarkets].sort((a, b) => Number(a.id - b.id));
  if (list.length === 0) {
    return <Empty title="No markets in this session">Add markets from the Settings tab — search Polymarket or paste a market link.</Empty>;
  }
  return (
    <div className="space-y-4">
      {list.map(sm => (
        <MarketPanel key={sm.id.toString()} ctx={ctx} sm={sm} />
      ))}
    </div>
  );
}

/** Forecast rows → a dashed continuation of the price and its q10–q90 band. */
function forecastShapes(f: PathForecast | undefined): { line?: TSeries; band?: TBand } {
  if (!f || f.point.length === 0) return {};
  const t0 = tsMs(f.baseTs);
  const step = f.stepSec * 1000;
  const at = (i: number) => t0 + (i + 1) * step;
  return {
    line: {
      id: 'fc',
      label: `forecast (${f.model}${f.newsAdjusted ? ', news-adjusted' : ''})`,
      color: 'var(--s1)',
      dashed: true,
      points: [{ t: t0, v: f.lastPrice }, ...f.point.map((v, i) => ({ t: at(i), v }))],
    },
    band: {
      id: 'band',
      label: 'q10–q90',
      color: 'var(--s1)',
      points: [
        { t: t0, lo: f.lastPrice, hi: f.lastPrice },
        ...f.point.map((_, i) => ({ t: at(i), lo: f.q10[i] ?? f.point[i], hi: f.q90[i] ?? f.point[i] })),
      ],
    },
  };
}

function MarketPanel({ ctx, sm }: { ctx: SessionCtx; sm: SessionMarket }) {
  const cid = sm.conditionId;
  const m = ctx.markets.get(cid);
  const now = useNow(30_000);
  const cutoff = useCutoff(WINDOW_MS);
  const barsQ = useMemo(() => tables.priceBar.where(r => r.conditionId.eq(cid).and(r.ts.gte(cutoff))), [cid, cutoff]);
  const fcQ = useMemo(() => tables.pathForecast.where(r => r.conditionId.eq(cid)), [cid]);
  const [bars, barsReady] = useTable(barsQ);
  const [forecasts] = useTable(fcQ);
  const [signals] = useSignals(useMemo(() => [cid], [cid]), cutoff);
  const recent = signals.slice(0, 6);
  const news = useNews(useMemo(() => recent.map(s => s.newsId), [recent]));

  const sortedBars = useMemo(() => [...bars].sort((a, b) => Number(a.ts.microsSinceUnixEpoch - b.ts.microsSinceUnixEpoch)), [bars]);
  const latestFc = useMemo(
    () => forecasts.reduce<PathForecast | undefined>((best, f) => (!best || f.createdAt.microsSinceUnixEpoch > best.createdAt.microsSinceUnixEpoch ? f : best), undefined),
    [forecasts]
  );
  const { line, band } = forecastShapes(latestFc);
  const series: TSeries[] = [
    { id: 'px', label: 'price (YES)', color: 'var(--s1)', points: sortedBars.map(b => ({ t: tsMs(b.ts), v: b.close })) },
    ...(line ? [line] : []),
  ];
  const markers: TMarker[] = signals.map(s => ({
    t: tsMs(s.createdAt),
    dir: s.expectedDelta >= 0 ? 'up' : 'down',
    label: `${s.layer} ${points(s.expectedDelta)} · ${news.get(s.newsId.toString())?.title ?? `headline #${s.newsId.toString()}`}`,
  }));

  const lastBar = sortedBars[sortedBars.length - 1];
  const bid = lastBar?.bid ?? m?.bestBid;
  const ask = lastBar?.ask ?? m?.bestAsk;
  const spread = bid !== undefined && ask !== undefined && Number.isFinite(bid) && Number.isFinite(ask) ? ask - bid : undefined;

  return (
    <Card title={m?.category || 'market'} right={m?.slug ? <a className="text-accent hover:underline" href={`https://polymarket.com/market/${m.slug}`} target="_blank" rel="noopener noreferrer">polymarket ↗</a> : undefined}>
      <div className="space-y-3">
        <div>
          <h3 className="text-[15px] font-medium leading-snug">{ctx.label(cid)}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            {m?.resolved && <Pill className="text-ink">resolved {m.outcomeYes === 1 ? 'YES' : m.outcomeYes === 0 ? 'NO' : ''}</Pill>}
            {m && !m.active && !m.resolved && <Pill>inactive</Pill>}
            {m?.negRisk && <Pill>neg-risk</Pill>}
            {sm.prior !== undefined && <span>your prior {pct(sm.prior, 0)}</span>}
            {sm.note && <span className="text-ink-2">“{sm.note}”</span>}
            {!m && <span>waiting for the engine to fetch market data…</span>}
          </div>
        </div>

        <div className="num grid grid-cols-3 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-4 lg:grid-cols-8">
          <Kv k="bid" v={cents(bid)} />
          <Kv k="ask" v={cents(ask)} />
          <Kv k="spread" v={spread === undefined ? '—' : cents(spread)} />
          <Kv k="last" v={cents(lastBar?.close ?? m?.lastPrice)} />
          <Kv k="taker fee" v={m ? pct(m.feeRate) : '—'} title="fee = shares × rate × p × (1 − p)" />
          <Kv k="24h volume" v={m ? `$${compact(m.volumeDay)}` : '—'} />
          <Kv k="liquidity" v={m ? `$${compact(m.liquidity)}` : '—'} />
          <Kv k="ends" v={m ? dateOnly(m.endDate) : '—'} />
        </div>

        <div className={barsReady ? undefined : 'opacity-50'}>
          <TimeChart
            ariaLabel={`YES price of ${ctx.label(cid)}, last 24 hours, with forecast and signals`}
            height={240}
            yFormat={v => cents(v, 0)}
            clamp={[0, 1]}
            now={now}
            series={series}
            bands={band ? [band] : []}
            markers={markers}
            table={{
              head: ['time', 'close', 'bid', 'ask'],
              rows: [...sortedBars].reverse().slice(0, 300).map(b => [dateTime(tsMs(b.ts)), cents(b.close), cents(b.bid), cents(b.ask)]),
            }}
          />
          {latestFc && (
            <div className="mt-1 text-[11px] text-muted">
              forecast from {relTime(tsMs(latestFc.createdAt), now)} · {latestFc.point.length} steps of {latestFc.stepSec / 60} min
            </div>
          )}
        </div>

        <div>
          <div className="mb-1 font-mono text-[10.5px] uppercase tracking-wider text-muted">Recent signals (24h)</div>
          {recent.length === 0 ? (
            <div className="text-xs text-muted">No signals in the last 24 hours — the engine creates them when a relevant headline hits this market.</div>
          ) : (
            <ul className="divide-y divide-line">
              {recent.map(s => (
                <SignalRow key={s.id.toString()} s={s} news={news.get(s.newsId.toString())} label={ctx.label(cid)} compact />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function Kv({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="font-sans text-[10.5px] text-muted">{k}</div>
      <div className="truncate text-ink">{v}</div>
    </div>
  );
}

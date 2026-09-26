'use client';

import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import { BarChart, type Bar } from '@/components/charts/bar-chart';
import { Card, Empty, StatTile, TableWrap } from '@/components/ui';
import { compact, dateTime, int, pct, tsMs, usd, usdFine } from '@/lib/format';
import { useCutoff, useNow } from '@/lib/stdb';

const HOUR = 3_600_000;
const WINDOW_H = 48;

/** llm_usage rows are (hour, route, model) buckets written by the engine. */
export function LlmUsagePanel() {
  const cutoff = useCutoff(WINDOW_H * HOUR, HOUR);
  const q = useMemo(() => tables.llmUsage.where(r => r.hour.gte(cutoff)), [cutoff]);
  const [rows, ready] = useTable(q);
  const now = useNow(60_000);

  const { bars, byModel, totals } = useMemo(() => {
    const hours = new Map<number, { cost: number; calls: number; tokIn: number; cached: number }>();
    const models = new Map<string, { cost: number; calls: number; tokIn: number; tokOut: number; cached: number; thought: number }>();
    let cost = 0;
    let calls = 0;
    let tokIn = 0;
    let cached = 0;
    for (const u of rows) {
      const h = tsMs(u.hour);
      const b = hours.get(h) ?? { cost: 0, calls: 0, tokIn: 0, cached: 0 };
      b.cost += u.costUsd;
      b.calls += u.calls;
      b.tokIn += u.tokensIn;
      b.cached += u.cachedTokens;
      hours.set(h, b);
      const key = `${u.model} · ${u.route}`;
      const m = models.get(key) ?? { cost: 0, calls: 0, tokIn: 0, tokOut: 0, cached: 0, thought: 0 };
      m.cost += u.costUsd;
      m.calls += u.calls;
      m.tokIn += u.tokensIn;
      m.tokOut += u.tokensOut;
      m.cached += u.cachedTokens;
      m.thought += u.thoughtTokens;
      models.set(key, m);
      cost += u.costUsd;
      calls += u.calls;
      tokIn += u.tokensIn;
      cached += u.cachedTokens;
    }
    const bars: Bar[] = [...hours.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, b]) => ({
        t,
        v: b.cost,
        tip: [
          [int(b.calls), 'calls'],
          [b.tokIn > 0 ? pct(b.cached / b.tokIn, 0) : '—', 'cache hit'],
        ],
      }));
    const byModel = [...models.entries()].sort((a, b) => b[1].cost - a[1].cost);
    return { bars, byModel, totals: { cost, calls, tokIn, cached } };
  }, [rows]);

  const t1 = Math.floor(now / HOUR) * HOUR + HOUR;
  const t0 = t1 - WINDOW_H * HOUR;

  return (
    <Card title={`LLM usage · last ${WINDOW_H}h`}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Spend" value={usd(totals.cost)} />
          <StatTile label="Calls" value={int(totals.calls)} />
          <StatTile label="Input tokens" value={compact(totals.tokIn)} />
          <StatTile label="Cache hit" value={totals.tokIn > 0 ? pct(totals.cached / totals.tokIn, 0) : '—'} sub="cached ÷ input tokens" />
        </div>
        {!ready ? (
          <div className="text-xs text-muted">subscribing…</div>
        ) : rows.length === 0 ? (
          <Empty title="No model calls in the last 48 hours">
            Every Gemini call is metered per hour, route and model. Without an API key the engine runs on heuristics and spends nothing.
          </Empty>
        ) : (
          <>
            <div>
              <div className="mb-1 text-xs text-ink-2">Cost per hour</div>
              <BarChart
                bars={bars}
                bucketMs={HOUR}
                t0={t0}
                t1={t1}
                yFormat={v => (v < 1 ? `$${v.toFixed(2)}` : usd(v, 0))}
                valueLabel="cost"
                ariaLabel="LLM cost per hour, last 48 hours"
                table={{
                  head: ['hour', 'cost', 'calls', 'cache hit'],
                  rows: [...bars].reverse().map(b => [dateTime(b.t), usdFine(b.v), b.tip?.[0][0] ?? '', b.tip?.[1][0] ?? '']),
                }}
              />
            </div>
            <TableWrap>
              <table className="tbl min-w-[720px]">
                <thead>
                  <tr>
                    <th>Model · route</th>
                    <th className="r">Calls</th>
                    <th className="r">Input</th>
                    <th className="r">Output</th>
                    <th className="r">Thinking</th>
                    <th className="r">Cache hit</th>
                    <th className="r">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.map(([k, m]) => (
                    <tr key={k}>
                      <td className="font-mono text-[12px] text-ink">{k}</td>
                      <td className="num r">{int(m.calls)}</td>
                      <td className="num r">{compact(m.tokIn)}</td>
                      <td className="num r">{compact(m.tokOut)}</td>
                      <td className="num r">{compact(m.thought)}</td>
                      <td className="num r">{m.tokIn > 0 ? pct(m.cached / m.tokIn, 0) : '—'}</td>
                      <td className="num r">{usdFine(m.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </>
        )}
      </div>
    </Card>
  );
}

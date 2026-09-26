'use client';

import { MarketSearch } from '@/components/market-search';
import { Button, cx, Empty, inputCls } from '@/components/ui';
import { cents, dateOnly, pct, shortHex } from '@/lib/format';
import type { GammaMarket } from '@/lib/gamma';
import { marketTitle } from '@/lib/gamma';
import type { Draft, PickedMarket } from './draft';

function toPicked(m: GammaMarket): PickedMarket {
  return {
    conditionId: m.conditionId,
    question: marketTitle(m),
    slug: m.slug,
    eventTitle: m.eventTitle,
    yesPrice: m.yesPrice,
    endDate: m.endDate,
    feeRate: m.feeRate,
    note: '',
    prior: undefined,
  };
}

export function StepMarkets({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const selected = new Set(d.markets.map(m => m.conditionId));
  const update = (cid: string, patch: Partial<PickedMarket>) =>
    set({ markets: d.markets.map(m => (m.conditionId === cid ? { ...m, ...patch } : m)) });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-medium">Find markets</h3>
        <p className="text-xs text-muted">
          The session watches only these markets: headlines are matched against them, and the engine forecasts and trades them.
        </p>
        <MarketSearch selected={selected} onPick={m => set({ markets: [...d.markets, toPicked(m)] })} />
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-medium">
          Selected <span className="num text-muted">{d.markets.length}</span>
        </h3>
        {d.markets.length === 0 ? (
          <Empty title="No markets selected yet">Search on the left, or paste a Polymarket link. You can add more later in the session’s settings.</Empty>
        ) : (
          <ul className="space-y-2">
            {d.markets.map(m => (
              <li key={m.conditionId} className="rounded-lg border border-line bg-bg p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-ink">{m.question}</div>
                    <div className="num mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
                      <span>YES {cents(m.yesPrice)}</span>
                      <span>ends {dateOnly(m.endDate)}</span>
                      <span>fee {pct(m.feeRate)}</span>
                      <span title={m.conditionId}>{shortHex(m.conditionId, 8)}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${m.question}`}
                    onClick={() => set({ markets: d.markets.filter(x => x.conditionId !== m.conditionId) })}
                  >
                    ✕
                  </Button>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_120px]">
                  <input
                    className={inputCls}
                    placeholder="Note for the agents (optional): what matters, what to ignore"
                    value={m.note}
                    onChange={e => update(m.conditionId, { note: e.target.value })}
                    aria-label="Market note"
                  />
                  <PriorInput value={m.prior} onChange={prior => update(m.conditionId, { prior })} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Prior probability entered as a percent (1–99), stored as 0–1. */
export function PriorInput({ value, onChange }: { value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <div className="relative">
      <input
        type="number"
        min={1}
        max={99}
        step={1}
        className={cx(inputCls, 'num pr-14')}
        placeholder="prior"
        title="Your prior probability for YES, in percent (optional)"
        value={value === undefined ? '' : Math.round(value * 1000) / 10}
        onChange={e => {
          const v = e.target.value;
          if (v === '') return onChange(undefined);
          const n = Number(v);
          if (Number.isFinite(n)) onChange(Math.min(99, Math.max(1, n)) / 100);
        }}
        aria-label="Prior probability of YES (percent)"
      />
      <span className="pointer-events-none absolute right-2.5 top-1.5 text-xs text-muted">% YES</span>
    </div>
  );
}

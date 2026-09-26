'use client';

import { useState } from 'react';
import { RiskEditor, RiskPresets } from '@/components/config-editors';
import { cx, Field, inputCls } from '@/components/ui';
import type { Draft } from './draft';

export function StepMoney({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  const [advanced, setAdvanced] = useState(false);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-[240px_1fr]">
        <Field label="Bankroll (USD)" hint="The money this session may put at risk. Paper sessions simulate it.">
          <input
            type="number"
            min={1}
            step={50}
            className={cx(inputCls, 'num')}
            value={Number.isFinite(d.bankrollUsd) ? d.bankrollUsd : ''}
            onChange={e => set({ bankrollUsd: Number(e.target.value) })}
          />
        </Field>
        <div>
          <div className="mb-1 text-xs text-ink-2">Mode</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <ModeCard
              active={d.mode === 'paper'}
              onClick={() => set({ mode: 'paper' })}
              title="◌ Paper"
              body="Simulated fills against the live order book. No wallet, no money at risk. Builds the track record live trading requires."
              tag="recommended"
            />
            <ModeCard
              active={d.mode === 'live'}
              onClick={() => set({ mode: 'live' })}
              title="$ Live"
              body="Real orders on Polymarket. Starts as “awaiting approval”: an admin must approve it in Settings, and the engine must run with MIDAS_LIVE_TRADING=true and pass its paper track-record readiness gate."
              tag="real money"
            />
          </div>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">Risk profile</h3>
          <button type="button" className="text-xs text-accent hover:underline" onClick={() => setAdvanced(!advanced)}>
            {advanced ? 'hide advanced' : 'advanced…'}
          </button>
        </div>
        <RiskPresets value={d.risk} onChange={risk => set({ risk })} />
        {advanced && (
          <div className="mt-4 rounded-lg border border-line bg-bg p-4">
            <RiskEditor value={d.risk} onChange={risk => set({ risk })} />
          </div>
        )}
      </div>
    </div>
  );
}

function ModeCard({ active, onClick, title, body, tag }: { active: boolean; onClick: () => void; title: string; body: string; tag: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'rounded-lg border p-3 text-left transition-colors',
        active ? 'border-accent bg-accent/10' : 'border-line bg-bg hover:border-line-strong'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-ink">{title}</span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-muted">{tag}</span>
      </div>
      <div className="mt-1 text-[11.5px] leading-snug text-muted">{body}</div>
    </button>
  );
}

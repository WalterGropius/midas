'use client';

import { RISK_PRESETS, type IntelSettings, type RiskLimits } from '@midas/core';
import { cents, int, pct, points, usd } from '@/lib/format';
import { cx, Segmented } from './ui';

type NumKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

interface SliderSpec<T> {
  key: NumKey<T>;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  hint: string;
}

const RISK_FIELDS: SliderSpec<RiskLimits>[] = [
  { key: 'kellyFraction', label: 'Kelly fraction', min: 0, max: 1, step: 0.01, fmt: v => `${v.toFixed(2)}×`, hint: 'Share of the full-Kelly stake. Quarter Kelly is the research default.' },
  { key: 'maxPositionPct', label: 'Max position', min: 0, max: 0.25, step: 0.005, fmt: v => pct(v), hint: 'Cap per market, as a share of equity.' },
  { key: 'maxGrossExposurePct', label: 'Max gross exposure', min: 0, max: 1, step: 0.01, fmt: v => pct(v, 0), hint: 'Total open risk across every market.' },
  { key: 'maxDailyLossPct', label: 'Daily loss stop', min: 0, max: 0.3, step: 0.005, fmt: v => pct(v), hint: 'No new risk for the rest of the day after losing this much.' },
  { key: 'maxDrawdownPct', label: 'Drawdown stop', min: 0, max: 0.6, step: 0.01, fmt: v => pct(v, 0), hint: 'Stop opening positions below this drawdown from peak equity.' },
  { key: 'minEdge', label: 'Min edge', min: 0, max: 0.2, step: 0.005, fmt: v => points(v).replace('+', ''), hint: 'Required gap between fair value (after fees) and the price paid.' },
  { key: 'maxSpread', label: 'Max spread', min: 0, max: 0.2, step: 0.005, fmt: v => cents(v), hint: 'Skip order books wider than this.' },
  { key: 'modelTrust', label: 'Model trust', min: 0, max: 1, step: 0.01, fmt: v => v.toFixed(2), hint: 'Weight of the model against the market price (0 = pure market).' },
  { key: 'maxOpenPositions', label: 'Max open positions', min: 1, max: 100, step: 1, fmt: v => int(v), hint: 'Concurrent positions across all markets of the session.' },
];

const INTEL_FIELDS: SliderSpec<IntelSettings>[] = [
  { key: 'swarmSize', label: 'Swarm size', min: 1, max: 16, step: 1, fmt: v => `${v} agents`, hint: 'Flash forecasters asked per relevant headline × market.' },
  { key: 'proCallsPerHour', label: 'Pro calls / hour', min: 0, max: 120, step: 1, fmt: v => int(v), hint: 'Ceiling on deep supervisor reviews.' },
  { key: 'escalateEdge', label: 'Escalate at edge ≥', min: 0, max: 0.3, step: 0.005, fmt: v => points(v).replace('+', ''), hint: 'Send to the Pro supervisor when the swarm sees this much edge…' },
  { key: 'escalateDisagreement', label: 'Escalate at disagreement ≥', min: 0, max: 2, step: 0.05, fmt: v => v.toFixed(2), hint: '…or when the swarm disagrees this much (spread of member forecasts).' },
  { key: 'dailyLlmBudgetUsd', label: 'Daily LLM budget', min: 0, max: 200, step: 1, fmt: v => usd(v, 0), hint: 'Hard cap on model spend for this session per UTC day.' },
];

function Slider<T>({ spec, value, onChange }: { spec: SliderSpec<T>; value: number; onChange: (v: number) => void }) {
  const id = `sl-${String(spec.key)}`;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs text-ink-2">
          {spec.label}
        </label>
        <span className="num text-xs text-ink">{spec.fmt(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        className="w-full"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
      <div className="text-[11px] leading-snug text-muted">{spec.hint}</div>
    </div>
  );
}

const PRESET_COPY: Record<keyof typeof RISK_PRESETS, string> = {
  conservative: 'Small stakes, bigger edge required, early drawdown stop.',
  balanced: 'Quarter Kelly, 3% per market, 40% gross — the research default.',
  aggressive: 'Larger stakes and exposure; accepts deeper drawdowns.',
};

function presetOf(r: RiskLimits): keyof typeof RISK_PRESETS | undefined {
  return (Object.keys(RISK_PRESETS) as (keyof typeof RISK_PRESETS)[]).find(k =>
    (Object.keys(r) as (keyof RiskLimits)[]).every(f => RISK_PRESETS[k][f] === r[f])
  );
}

export function RiskPresets({ value, onChange }: { value: RiskLimits; onChange: (r: RiskLimits) => void }) {
  const active = presetOf(value);
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {(Object.keys(RISK_PRESETS) as (keyof typeof RISK_PRESETS)[]).map(k => {
        const p = RISK_PRESETS[k];
        return (
          <button
            key={k}
            type="button"
            aria-pressed={active === k}
            onClick={() => onChange({ ...p })}
            className={cx(
              'rounded-lg border p-3 text-left transition-colors',
              active === k ? 'border-accent bg-accent/10' : 'border-line bg-bg hover:border-line-strong'
            )}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium capitalize text-ink">{k}</span>
              {active === k && <span className="text-xs text-accent">✓ selected</span>}
            </div>
            <div className="mt-1 text-[11px] text-muted">{PRESET_COPY[k]}</div>
            <dl className="num mt-2 grid grid-cols-2 gap-x-2 text-[11px] text-ink-2">
              <dt className="text-muted">Kelly</dt>
              <dd>{p.kellyFraction.toFixed(2)}×</dd>
              <dt className="text-muted">per market</dt>
              <dd>{pct(p.maxPositionPct)}</dd>
              <dt className="text-muted">gross</dt>
              <dd>{pct(p.maxGrossExposurePct, 0)}</dd>
              <dt className="text-muted">dd stop</dt>
              <dd>{pct(p.maxDrawdownPct, 0)}</dd>
              <dt className="text-muted">min edge</dt>
              <dd>{points(p.minEdge).replace('+', '')}</dd>
            </dl>
          </button>
        );
      })}
    </div>
  );
}

const STRATEGY_COPY: Record<string, string> = {
  reaction: 'Trade the expected short-term move after news, exit on target, stop or time.',
  value: 'Hold where the blind fair value disagrees with the price, until it converges.',
  both: 'Run both playbooks; each position records which one opened it.',
};

export function RiskEditor({ value, onChange }: { value: RiskLimits; onChange: (r: RiskLimits) => void }) {
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs text-ink-2">Strategy</div>
        <Segmented
          label="Strategy"
          options={[
            { id: 'reaction', label: 'reaction' },
            { id: 'value', label: 'value' },
            { id: 'both', label: 'both' },
          ]}
          value={(['reaction', 'value', 'both'].includes(value.strategy) ? value.strategy : 'both') as 'reaction' | 'value' | 'both'}
          onChange={s => onChange({ ...value, strategy: s })}
        />
        <div className="mt-1 text-[11px] text-muted">{STRATEGY_COPY[value.strategy] ?? ''}</div>
      </div>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {RISK_FIELDS.map(f => (
          <Slider key={f.key} spec={f} value={value[f.key]} onChange={v => onChange({ ...value, [f.key]: v })} />
        ))}
      </div>
    </div>
  );
}

export function IntelEditor({ value, onChange }: { value: IntelSettings; onChange: (i: IntelSettings) => void }) {
  return (
    <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      {INTEL_FIELDS.map(f => (
        <Slider key={f.key} spec={f} value={value[f.key]} onChange={v => onChange({ ...value, [f.key]: v })} />
      ))}
    </div>
  );
}

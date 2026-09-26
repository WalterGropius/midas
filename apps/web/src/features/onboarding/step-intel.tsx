'use client';

import { IntelEditor } from '@/components/config-editors';
import type { Draft } from './draft';

const LAYERS = [
  {
    name: 'System-1 reflexes',
    who: 'Jev / Laya · ms',
    body: 'Typed yes/no, choice and score questions fired on every headline × market: relevant? direction? urgent? new? Cheap enough to ask everything.',
  },
  {
    name: 'Flash swarm',
    who: 'Gemini Flash · seconds',
    body: 'A population of forecasters with different personas estimates the reaction, blind to the market price. Pooled by formula, never by another LLM.',
  },
  {
    name: 'Pro supervisor',
    who: 'Gemini Pro · on escalation',
    body: 'Called only when the swarm sees a big edge or disagrees. Reviews the reasoning with memory and the wiki before any decision.',
  },
  {
    name: 'Coach & evolution',
    who: 'offline · hours',
    body: 'Scores every forecast against realized prices, recalibrates, rewrites reflexes and breeds better agents — keeping only changes that replay better.',
  },
];

export function StepIntel({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <div className="space-y-6">
      <ol className="grid gap-2 md:grid-cols-4">
        {LAYERS.map((l, i) => (
          <li key={l.name} className="relative rounded-lg border border-line bg-bg p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] font-medium text-ink">
                <span className="num mr-1.5 text-muted">{i + 1}</span>
                {l.name}
              </span>
            </div>
            <div className="font-mono text-[10.5px] uppercase tracking-wide text-muted">{l.who}</div>
            <p className="mt-1.5 text-[11.5px] leading-snug text-ink-2">{l.body}</p>
            {i < LAYERS.length - 1 && (
              <span aria-hidden className="absolute -right-2 top-1/2 hidden -translate-y-1/2 text-muted md:block">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="rounded-lg border border-line bg-bg p-4">
        <IntelEditor value={d.intel} onChange={intel => set({ intel })} />
      </div>
      <p className="text-xs text-muted">
        Costs scale with swarm size × relevant headlines. Reflexes filter most headlines out before any Flash call, and the daily
        budget is a hard stop for this session.
      </p>
    </div>
  );
}

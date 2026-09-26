'use client';

import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import { Card, Empty, Expandable } from '@/components/ui';
import { dateTime, fixed, relTime, tsMs } from '@/lib/format';
import { useNow } from '@/lib/stdb';

const DECISION: Record<string, { icon: string; cls: string }> = {
  kept: { icon: '✓', cls: 'text-ink' },
  reverted: { icon: '↺', cls: 'text-muted' },
  crash: { icon: '✕', cls: 'text-crit' },
};

/** Ratchet trials: a mutation is kept only if it replays better than its parent. */
export function EvolutionTimeline() {
  const [trials, ready] = useTable(tables.evolutionTrial);
  const [agents] = useTable(tables.agent);
  const names = useMemo(() => new Map(agents.map(a => [a.id.toString(), a.name])), [agents]);
  const now = useNow(30_000);
  const shown = [...trials].sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch)).slice(0, 60);
  const kept = trials.filter(t => t.decision === 'kept').length;

  const subjectLabel = (subject: string) => {
    const m = /^agent:(\d+)$/.exec(subject);
    if (m) return names.get(m[1]) ?? subject;
    return subject.replace(/^reflex:/, 'reflex ');
  };

  return (
    <Card title={`Evolution · ${kept}/${trials.length} kept`}>
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : shown.length === 0 ? (
        <Empty title="No trials yet">
          The coach mutates agent instructions and reflex definitions offline, replays them on resolved history (point-in-time), and keeps
          a change only when it scores better. Trials appear once enough forecasts have been scored.
        </Empty>
      ) : (
        <ol className="max-h-[560px] space-y-0 overflow-y-auto">
          {shown.map(t => {
            const d = DECISION[t.decision] ?? { icon: '•', cls: 'text-ink-2' };
            const delta = t.candidateScore - t.baselineScore;
            return (
              <li key={t.id.toString()} className="relative border-l border-line py-2 pl-4 text-xs">
                <span aria-hidden className={`absolute -left-[5px] top-3 h-2.5 w-2.5 rounded-full border-2 border-surface ${t.decision === 'crash' ? 'bg-crit' : t.decision === 'kept' ? 'bg-ink' : 'bg-line-strong'}`} />
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium text-ink">{subjectLabel(t.subject)}</span>
                  <span className="num text-muted">gen {t.generation}</span>
                  <span className={`font-mono text-[11px] uppercase ${d.cls}`}>
                    <span aria-hidden>{d.icon}</span> {t.decision}
                  </span>
                  <span className="num ml-auto text-muted" title={dateTime(tsMs(t.createdAt))}>
                    {relTime(tsMs(t.createdAt), now)}
                  </span>
                </div>
                <div className="num mt-0.5 text-ink-2">
                  {t.metric || 'score'} {fixed(t.baselineScore, 4)} → {fixed(t.candidateScore, 4)}{' '}
                  <span className="text-muted">
                    ({delta >= 0 ? '+' : '−'}
                    {fixed(Math.abs(delta), 4)}, n={t.nEval})
                  </span>
                </div>
                {t.mutation && (
                  <div className="mt-1 text-[11.5px] text-muted">
                    <Expandable text={t.mutation} n={160} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

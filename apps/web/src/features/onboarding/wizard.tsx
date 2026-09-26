'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '@midas/stdb-bindings';
import { Button, cx } from '@/components/ui';
import { sameIdentity, useAction, useConnection } from '@/lib/stdb';
import { EMPTY_DRAFT, loadDraft, saveDraft, type Draft } from './draft';
import { StepIntel } from './step-intel';
import { StepKnowledge } from './step-knowledge';
import { StepMarkets } from './step-markets';
import { StepMoney } from './step-money';
import { StepReview, useSeedFiles } from './step-review';

const STEPS = ['Money & mode', 'Markets', 'Knowledge', 'Intelligence', 'Review'] as const;

function problemsOf(d: Draft): string[] {
  const out: string[] = [];
  if (!(d.bankrollUsd > 0)) out.push('Required: a bankroll above $0 (step 1).');
  if (d.bankrollUsd > 10_000_000) out.push('Required: bankroll at most $10M (step 1).');
  if (!d.name.trim()) out.push('Required: a session name (step 3).');
  if (d.markets.length === 0) out.push('No markets selected — the session will idle until you add some in its settings.');
  if (d.feeds.length === 0) out.push('No news feeds selected — nothing will trigger forecasts.');
  if (d.mode === 'live') out.push('Live mode: the session waits for admin approval and the engine’s live gates before any order.');
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function Wizard() {
  const router = useRouter();
  const [d, setD] = useState<Draft>(EMPTY_DRAFT);
  const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState(0);
  const { identity, isActive } = useSpacetimeDB();
  const conn = useConnection();
  useTable(tables.session); // keep sessions in the client cache to find the new one
  const createSession = useReducer(reducers.createSession);
  const { run, pending, error } = useAction();
  const files = useSeedFiles(d);

  useEffect(() => {
    setD(loadDraft());
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => saveDraft(d), 400);
    return () => clearTimeout(t);
  }, [d, loaded]);

  const set = useCallback((p: Partial<Draft>) => setD(prev => ({ ...prev, ...p })), []);

  const newestOwnedId = useCallback((): bigint => {
    let max = 0n;
    if (!conn) return max;
    for (const s of conn.db.session.iter()) if (sameIdentity(s.owner, identity) && s.id > max) max = s.id;
    return max;
  }, [conn, identity]);

  const launch = () =>
    void run(async () => {
      const before = newestOwnedId();
      await createSession({
        name: d.name.trim(),
        mode: d.mode,
        bankrollUsd: d.bankrollUsd,
        risk: d.risk,
        intel: d.intel,
        thesis: d.thesis,
        markets: d.markets.map(m => ({ conditionId: m.conditionId, note: m.note.trim(), prior: m.prior })),
        files: files.map(f => ({ path: f.path, kind: f.kind, content: f.content })),
      });
      // The reducer returns nothing: find the row it inserted for us.
      let id = 0n;
      for (let i = 0; i < 30 && id <= before; i++) {
        id = newestOwnedId();
        if (id <= before) await sleep(100);
      }
      saveDraft(null);
      router.push(id > before ? `/session?id=${id.toString()}` : '/');
    });

  const problems = problemsOf(d);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">New session</h1>
          <p className="text-xs text-muted">Money + markets + knowledge → a seed folder the agents grow into a wiki.</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (window.confirm('Discard this draft and start over?')) {
              setD(EMPTY_DRAFT);
              setStep(0);
            }
          }}
        >
          Reset draft
        </Button>
      </div>

      <ol className="flex gap-1 overflow-x-auto border-b border-line pb-px">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => setStep(i)}
              aria-current={i === step ? 'step' : undefined}
              className={cx(
                '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-[13px]',
                i === step ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink-2'
              )}
            >
              <span className={cx('num flex h-5 w-5 items-center justify-center rounded-full border text-[11px]', i < step ? 'border-accent text-accent' : i === step ? 'border-ink text-ink' : 'border-line-strong')}>
                {i < step ? '✓' : i + 1}
              </span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      <div className="min-h-[360px]">
        {step === 0 && <StepMoney d={d} set={set} />}
        {step === 1 && <StepMarkets d={d} set={set} />}
        {step === 2 && <StepKnowledge d={d} set={set} />}
        {step === 3 && <StepIntel d={d} set={set} />}
        {step === 4 && (
          <StepReview d={d} files={files} problems={problems} launching={pending} error={error} onLaunch={launch} connected={isActive} />
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line pt-3">
        <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
          ← Back
        </Button>
        {step < STEPS.length - 1 && (
          <Button variant="primary" onClick={() => setStep(step + 1)}>
            Next: {STEPS[step + 1]} →
          </Button>
        )}
      </div>
    </div>
  );
}

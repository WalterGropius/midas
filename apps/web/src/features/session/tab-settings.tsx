'use client';

import { useState } from 'react';
import { useReducer, useSpacetimeDB } from 'spacetimedb/react';
import type { IntelSettings, RiskLimits } from '@midas/core';
import { reducers } from '@midas/stdb-bindings';
import { IntelEditor, RiskEditor, RiskPresets } from '@/components/config-editors';
import { MarketSearch } from '@/components/market-search';
import { Button, Card, ErrorText, Field, inputCls, cx } from '@/components/ui';
import { marketTitle, type GammaMarket } from '@/lib/gamma';
import { cents, pct, shortHex } from '@/lib/format';
import { sameIdentity, useAction } from '@/lib/stdb';
import { PriorInput } from '../onboarding/step-markets';
import type { SessionCtx } from './context';

export function SettingsTab({ ctx }: { ctx: SessionCtx }) {
  const { identity } = useSpacetimeDB();
  const mine = sameIdentity(ctx.session.owner, identity);
  return (
    <div className="space-y-4">
      {!mine && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-muted">
          Read-only: this session belongs to {shortHex(ctx.session.owner.toHexString())}. The server rejects changes from other identities.
        </div>
      )}
      <ConfigForm ctx={ctx} disabled={!mine} />
      <div className="grid gap-4 lg:grid-cols-2">
        <MarketsEditor ctx={ctx} disabled={!mine} />
        <ModeCard ctx={ctx} disabled={!mine} />
      </div>
    </div>
  );
}

function ConfigForm({ ctx, disabled }: { ctx: SessionCtx; disabled: boolean }) {
  const s = ctx.session;
  const initial = () => ({ name: s.name, bankrollUsd: s.bankrollUsd, thesis: s.thesis, risk: { ...s.risk } as RiskLimits, intel: { ...s.intel } as IntelSettings });
  const [f, setF] = useState(initial);
  const update = useReducer(reducers.updateSessionConfig);
  const { run, pending, error, clear } = useAction();
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(initial());
  const bankrollDelta = f.bankrollUsd - s.bankrollUsd;

  const save = () =>
    void run(async () => {
      await update({ sessionId: s.id, name: f.name, bankrollUsd: f.bankrollUsd, risk: f.risk, intel: f.intel, thesis: f.thesis });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    });

  return (
    <Card
      title="Configuration"
      right={
        <>
          {saved && <span className="text-good">✓ saved</span>}
          <Button size="sm" variant="ghost" disabled={!dirty || pending} onClick={() => setF(initial())}>
            Revert
          </Button>
          <Button size="sm" variant="primary" disabled={disabled || !dirty || pending || !(f.bankrollUsd > 0)} onClick={save}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </>
      }
    >
      <fieldset disabled={disabled} className="space-y-5">
        <ErrorText error={error} onClose={clear} />
        <div className="grid gap-4 md:grid-cols-[1fr_200px]">
          <Field label="Name">
            <input className={inputCls} value={f.name} maxLength={120} onChange={e => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field
            label="Bankroll (USD)"
            hint={bankrollDelta !== 0 ? `${bankrollDelta > 0 ? 'Deposit' : 'Withdrawal'} of $${Math.abs(bankrollDelta).toLocaleString()} against cash` : undefined}
          >
            <input
              type="number"
              min={1}
              className={cx(inputCls, 'num')}
              value={Number.isFinite(f.bankrollUsd) ? f.bankrollUsd : ''}
              onChange={e => setF({ ...f, bankrollUsd: Number(e.target.value) })}
            />
          </Field>
        </div>
        <Field label="Thesis" hint="Stored on the session; thesis.md in the wiki tab is the version agents read alongside the sources.">
          <textarea
            className={cx(inputCls, 'min-h-[110px] font-mono text-[12.5px]')}
            value={f.thesis}
            onChange={e => setF({ ...f, thesis: e.target.value })}
          />
        </Field>
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Risk</h3>
          <RiskPresets value={f.risk} onChange={risk => setF({ ...f, risk })} />
          <RiskEditor value={f.risk} onChange={risk => setF({ ...f, risk })} />
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Intelligence</h3>
          <IntelEditor value={f.intel} onChange={intel => setF({ ...f, intel })} />
        </div>
      </fieldset>
    </Card>
  );
}

function MarketsEditor({ ctx, disabled }: { ctx: SessionCtx; disabled: boolean }) {
  const add = useReducer(reducers.addSessionMarket);
  const remove = useReducer(reducers.removeSessionMarket);
  const { run, pending, error, clear } = useAction();
  const [pick, setPick] = useState<GammaMarket | null>(null);
  const [note, setNote] = useState('');
  const [prior, setPrior] = useState<number | undefined>(undefined);
  const selected = new Set(ctx.conditionIds);
  const list = [...ctx.sessionMarkets].sort((a, b) => Number(a.id - b.id));

  const confirmAdd = () =>
    pick &&
    void run(async () => {
      await add({ sessionId: ctx.session.id, market: { conditionId: pick.conditionId, note: note.trim(), prior } });
      setPick(null);
      setNote('');
      setPrior(undefined);
    });

  return (
    <Card title={`Markets · ${list.length}`}>
      <div className="space-y-3">
        <ErrorText error={error} onClose={clear} />
        {list.length === 0 ? (
          <div className="text-xs text-muted">No markets yet — add one below.</div>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {list.map(sm => {
              const m = ctx.markets.get(sm.conditionId);
              return (
                <li key={sm.id.toString()} className="flex items-start gap-2 px-3 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-ink">{ctx.label(sm.conditionId)}</div>
                    <div className="num mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
                      {m && <span>last {cents(m.lastPrice)}</span>}
                      {sm.prior !== undefined && <span>prior {pct(sm.prior, 0)}</span>}
                      {sm.note && <span className="font-sans text-ink-2">“{sm.note}”</span>}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || pending}
                    onClick={() => {
                      if (window.confirm('Stop watching this market? Open positions in it are still managed by the engine.'))
                        void run(() => remove({ id: sm.id }));
                    }}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {!disabled &&
          (pick ? (
            <div className="space-y-2 rounded-md border border-accent/50 bg-bg p-3">
              <div className="text-[13px]">{marketTitle(pick)}</div>
              <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
                <input className={inputCls} placeholder="Note for the agents (optional)" value={note} onChange={e => setNote(e.target.value)} />
                <PriorInput value={prior} onChange={setPrior} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" disabled={pending} onClick={confirmAdd}>
                  Add market
                </Button>
                <Button size="sm" onClick={() => setPick(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <MarketSearch selected={selected} onPick={setPick} pickLabel="Add…" />
          ))}
      </div>
    </Card>
  );
}

function ModeCard({ ctx, disabled }: { ctx: SessionCtx; disabled: boolean }) {
  const s = ctx.session;
  const setMode = useReducer(reducers.setSessionMode);
  const { run, pending, error, clear } = useAction();
  const live = s.mode === 'live';
  const switchMode = () => {
    const next = live ? 'paper' : 'live';
    const msg = live
      ? 'Switch back to paper trading? Positions must be closed first.'
      : 'Switch to LIVE trading with real money? The session pauses as “awaiting approval” until an admin approves it, and the engine must run with MIDAS_LIVE_TRADING=true and pass its paper track-record readiness gate. Positions must be closed first.';
    if (window.confirm(msg)) void run(() => setMode({ sessionId: s.id, mode: next }));
  };
  return (
    <Card title="Trading mode">
      <div className="space-y-3 text-xs">
        <div className="flex items-center gap-2 text-sm">
          Currently <span className={live ? 'font-medium text-serious' : 'font-medium'}>{live ? '$ live' : '◌ paper'}</span>
          {live && <span className="text-muted">· {s.liveApproved ? 'approved by an admin' : 'awaiting admin approval'}</span>}
        </div>
        <p className="text-muted">
          Paper mode simulates fills against the live book. Live mode is triple-gated: this switch, a per-session admin approval, and the
          engine’s own MIDAS_LIVE_TRADING flag plus readiness gate and hard caps on order and bankroll size.
        </p>
        <Button variant={live ? 'default' : 'danger'} disabled={disabled || pending} onClick={switchMode}>
          {live ? 'Switch to paper' : 'Switch to live…'}
        </Button>
        <ErrorText error={error} onClose={clear} />
      </div>
    </Card>
  );
}

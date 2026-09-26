'use client';

import Link from 'next/link';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '@midas/stdb-bindings';
import { Button, Card, Empty, ErrorText } from '@/components/ui';
import { pct, relTime, shortHex, tsMs, usd } from '@/lib/format';
import { useAction, useMyRole, useNow } from '@/lib/stdb';

/** Sessions in live mode waiting for an admin (approveLive). */
export function LiveApprovals() {
  const [sessions, ready] = useTable(tables.session.where(r => r.mode.eq('live')));
  const { role } = useMyRole();
  const approve = useReducer(reducers.approveLive);
  const { run, pending, error, clear } = useAction();
  const now = useNow(30_000);
  const queue = sessions.filter(s => !s.liveApproved && s.status !== 'archived');
  const approved = sessions.filter(s => s.liveApproved);
  const isAdmin = role === 'admin';

  const decide = (id: bigint, name: string, ok: boolean) => {
    if (ok && !window.confirm(`Approve LIVE trading with real money for "${name}"?`)) return;
    void run(() => approve({ sessionId: id, approve: ok }));
  };

  return (
    <Card title={`Live approval queue · ${queue.length}`}>
      <div className="space-y-3 text-xs">
        <ErrorText error={error} onClose={clear} />
        {!ready ? (
          <div className="text-muted">subscribing…</div>
        ) : queue.length === 0 ? (
          <Empty title="Nothing awaiting approval">Sessions switched to live mode wait here until an admin approves or rejects them.</Empty>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {queue.map(s => (
              <li key={s.id.toString()} className="space-y-1.5 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/session?id=${s.id.toString()}`} className="text-[13px] font-medium text-ink hover:text-accent">
                    {s.name}
                  </Link>
                  <span className="num text-muted">#{s.id.toString()}</span>
                  <span className="num text-muted">owner {shortHex(s.owner.toHexString())}</span>
                  <span className="num ml-auto text-muted">{relTime(tsMs(s.updatedAt), now)}</span>
                </div>
                <div className="num flex flex-wrap gap-x-3 text-[11px] text-ink-2">
                  <span>bankroll {usd(s.bankrollUsd, 0)}</span>
                  <span>Kelly {s.risk.kellyFraction.toFixed(2)}×</span>
                  <span>max {pct(s.risk.maxPositionPct)} / market</span>
                  <span>gross {pct(s.risk.maxGrossExposurePct, 0)}</span>
                  <span>dd stop {pct(s.risk.maxDrawdownPct, 0)}</span>
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="danger" disabled={!isAdmin || pending} title={isAdmin ? undefined : 'Admins only'} onClick={() => decide(s.id, s.name, true)}>
                    Approve live
                  </Button>
                  <Button size="sm" disabled={!isAdmin || pending} onClick={() => decide(s.id, s.name, false)}>
                    Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {approved.length > 0 && (
          <div>
            <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">Approved live · {approved.length}</div>
            <ul className="space-y-1">
              {approved.map(s => (
                <li key={s.id.toString()} className="flex items-center gap-2">
                  <Link href={`/session?id=${s.id.toString()}`} className="min-w-0 flex-1 truncate text-ink-2 hover:text-accent">
                    {s.name}
                  </Link>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!isAdmin || pending}
                    title="Revokes approval and pauses the session"
                    onClick={() => window.confirm(`Revoke live approval for "${s.name}"? It pauses.`) && decide(s.id, s.name, false)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!isAdmin && queue.length > 0 && <div className="text-[11px] text-muted">Only admins can approve live trading.</div>}
      </div>
    </Card>
  );
}

export function RiskWarning() {
  return (
    <section role="note" className="rounded-lg border border-serious/50 bg-serious/10 p-4 text-xs leading-relaxed text-ink-2">
      <h2 className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-serious">▲ Real money</h2>
      <p>
        Live sessions place real orders on Polymarket from the engine’s wallet. Prediction markets can go to zero; models are wrong in
        correlated ways; fills, fees and slippage differ from paper. Only fund what you can lose.
      </p>
      <p className="mt-2">Approving here is one of three independent gates. The engine additionally refuses to trade live unless:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        <li>
          it runs with <span className="num text-ink">MIDAS_LIVE_TRADING=true</span> and a configured wallet;
        </li>
        <li>
          the session passes the paper track-record <span className="text-ink">readiness gate</span> (
          <span className="num">MIDAS_LIVE_REQUIRE_READINESS</span>, on by default);
        </li>
        <li>
          each order and the session bankroll stay under hard caps (<span className="num">MIDAS_LIVE_MAX_ORDER_USD</span>,{' '}
          <span className="num">MIDAS_LIVE_MAX_BANKROLL_USD</span>).
        </li>
      </ul>
      <p className="mt-2">The global halt on the Command page stops every order in every session immediately.</p>
    </section>
  );
}

'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import type { Market, Session } from '@midas/stdb-bindings/types';
import { Sparkline } from '@/components/charts/sparkline';
import { ModeBadge, SessionStatusBadge } from '@/components/status';
import { Empty, Segmented, Stat } from '@/components/ui';
import { pct, pnlClass, points, relTime, signedPct, signedUsd, truncate, tsMs, usd } from '@/lib/format';
import { sameIdentity, useCutoff, useNow } from '@/lib/stdb';
import { SessionControls } from '../session-controls';

const STATUS_ORDER = ['running', 'pending_approval', 'paused', 'stopped', 'killed', 'archived'];

export function drawdown(s: Session): number {
  return s.peakEquityUsd > 0 ? Math.max(0, (s.peakEquityUsd - s.equityUsd) / s.peakEquityUsd) : 0;
}

export function SessionsGrid() {
  const { identity } = useSpacetimeDB();
  const [sessions, ready] = useTable(tables.session);
  const [openPositions] = useTable(tables.position.where(r => r.closed.eq(false)));
  const [markets] = useTable(tables.market);
  const [scope, setScope] = useState<'all' | 'mine' | 'archived'>('all');

  const marketMap = useMemo(() => new Map(markets.map(m => [m.conditionId, m])), [markets]);
  const openBySession = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of openPositions) m.set(p.sessionId.toString(), (m.get(p.sessionId.toString()) ?? 0) + 1);
    return m;
  }, [openPositions]);

  const shown = sessions
    .filter(s => (scope === 'archived' ? s.status === 'archived' : s.status !== 'archived'))
    .filter(s => scope !== 'mine' || sameIdentity(s.owner, identity))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || Number(b.id - a.id));

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-muted">
          Sessions <span className="num">{sessions.filter(s => s.status === 'running').length} running</span>
        </h2>
        <Segmented
          label="Which sessions"
          options={[
            { id: 'all', label: 'active' },
            { id: 'mine', label: 'mine' },
            { id: 'archived', label: 'archived' },
          ]}
          value={scope}
          onChange={setScope}
        />
      </div>
      {!ready ? (
        <div className="text-xs text-muted">subscribing to sessions…</div>
      ) : shown.length === 0 ? (
        <Empty title={scope === 'archived' ? 'No archived sessions' : 'No sessions yet'}>
          A session is one bankroll trading a set of markets with its own knowledge folder. Sessions run in parallel.{' '}
          <Link className="text-accent hover:underline" href="/onboarding">
            Create the first one →
          </Link>
        </Empty>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map(s => (
            <SessionCard key={s.id.toString()} s={s} openCount={openBySession.get(s.id.toString()) ?? 0} markets={marketMap} />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionCard({ s, openCount, markets }: { s: Session; openCount: number; markets: Map<string, Market> }) {
  const now = useNow(15_000);
  const eqCutoff = useCutoff(24 * 3_600_000);
  const decCutoff = useCutoff(7 * 86_400_000, 3_600_000);
  const eqQ = useMemo(() => tables.equityPoint.where(r => r.sessionId.eq(s.id).and(r.ts.gte(eqCutoff))), [s.id, eqCutoff]);
  const decQ = useMemo(() => tables.decision.where(r => r.sessionId.eq(s.id).and(r.createdAt.gte(decCutoff))), [s.id, decCutoff]);
  const [eq] = useTable(eqQ);
  const [decisions] = useTable(decQ);

  const spark = useMemo(() => eq.map(p => ({ t: tsMs(p.ts), v: p.equityUsd })).sort((a, b) => a.t - b.t), [eq]);
  const last = decisions.reduce<(typeof decisions)[number] | undefined>(
    (best, d) => (!best || d.createdAt.microsSinceUnixEpoch > best.createdAt.microsSinceUnixEpoch ? d : best),
    undefined
  );
  const pnl = s.equityUsd - s.bankrollUsd;
  const href = `/session?id=${s.id.toString()}`;

  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={href} className="block truncate text-[15px] font-medium text-ink hover:text-accent">
            {s.name}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <SessionStatusBadge status={s.status} title={s.statusReason || undefined} />
            <ModeBadge mode={s.mode} />
            {s.mode === 'live' && !s.liveApproved && <span className="text-[11px] text-serious">awaiting admin approval</span>}
          </div>
        </div>
        <span className="num shrink-0 text-[11px] text-muted">#{s.id.toString()}</span>
      </header>

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Equity" value={usd(s.equityUsd)} sub={`bankroll ${usd(s.bankrollUsd, 0)}`} />
        <Stat
          label="PnL"
          value={<span className={pnlClass(pnl)}>{signedPct(s.bankrollUsd > 0 ? pnl / s.bankrollUsd : 0)}</span>}
          sub={<span className={pnlClass(pnl)}>{signedUsd(pnl)}</span>}
        />
        <Stat label="Drawdown" value={pct(drawdown(s))} sub={`${openCount} open position${openCount === 1 ? '' : 's'}`} />
      </div>

      <Sparkline points={spark} baseline={s.bankrollUsd} ariaLabel={`${s.name} equity, last 24 hours`} />

      <div className="min-h-[34px] text-xs">
        {last ? (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 text-ink-2">
              <span className="font-mono uppercase text-ink">{last.action}</span>
              <span className="num">edge {points(last.edge)}</span>
              <span className="num">{usd(last.sizeUsd, 0)}</span>
              <span className={last.verdict === 'approved' ? 'text-ink-2' : 'text-muted'}>{last.verdict}</span>
              <span className="num ml-auto text-muted">{relTime(tsMs(last.createdAt), now)}</span>
            </div>
            <div className="truncate text-muted" title={markets.get(last.conditionId)?.question}>
              {truncate(markets.get(last.conditionId)?.question ?? last.conditionId, 90)}
            </div>
          </div>
        ) : (
          <div className="text-muted">No decisions in the last 7 days.</div>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2">
        <SessionControls session={s} />
        <Link href={href} className="shrink-0 text-xs text-accent hover:underline">
          open →
        </Link>
      </div>
    </article>
  );
}

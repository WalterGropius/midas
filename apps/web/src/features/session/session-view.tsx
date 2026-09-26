'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSpacetimeDB } from 'spacetimedb/react';
import { ModeBadge, SessionStatusBadge } from '@/components/status';
import { Empty, Stat, Tabs } from '@/components/ui';
import { dateTime, pct, pnlClass, shortHex, signedPct, signedUsd, tsMs, usd } from '@/lib/format';
import { sameIdentity } from '@/lib/stdb';
import { drawdown } from '../command/sessions-grid';
import { SessionControls } from '../session-controls';
import { useSessionData, type SessionCtx } from './context';
import { MarketsTab } from './tab-markets';
import { OverviewTab } from './tab-overview';
import { SettingsTab } from './tab-settings';
import { SignalsTab } from './tab-signals';
import { WikiTab } from './tab-wiki';

export const TAB_IDS = ['overview', 'markets', 'signals', 'wiki', 'settings'] as const;
export type TabId = (typeof TAB_IDS)[number];

export function SessionView({ id, tab }: { id: bigint; tab: TabId }) {
  const router = useRouter();
  const pathname = usePathname();
  const { ctx, ready } = useSessionData(id);

  if (!ctx) {
    return ready ? (
      <Empty title={`Session #${id.toString()} not found`}>
        It may have been created on another database. <Link className="text-accent hover:underline" href="/">Back to the command center</Link>.
      </Empty>
    ) : (
      <div className="py-20 text-center font-mono text-xs text-muted">subscribing to session #{id.toString()}…</div>
    );
  }

  const setTab = (t: TabId) => router.replace(`${pathname}?id=${id.toString()}${t === 'overview' ? '' : `&tab=${t}`}`, { scroll: false });
  const wikiCount = ctx.seedFiles.length;

  return (
    <div className="space-y-4">
      <Header ctx={ctx} />
      <Tabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'markets', label: 'Markets', count: ctx.sessionMarkets.length },
          { id: 'signals', label: 'Signals' },
          { id: 'wiki', label: 'Wiki', count: wikiCount },
          { id: 'settings', label: 'Settings' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'overview' && <OverviewTab ctx={ctx} />}
      {tab === 'markets' && <MarketsTab ctx={ctx} />}
      {tab === 'signals' && <SignalsTab ctx={ctx} />}
      {tab === 'wiki' && <WikiTab ctx={ctx} />}
      {tab === 'settings' && <SettingsTab ctx={ctx} />}
    </div>
  );
}

function Header({ ctx }: { ctx: SessionCtx }) {
  const { identity } = useSpacetimeDB();
  const s = ctx.session;
  const pnl = s.equityUsd - s.bankrollUsd;
  const mine = sameIdentity(s.owner, identity);
  return (
    <header className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{s.name}</h1>
            <SessionStatusBadge status={s.status} title={s.statusReason || undefined} />
            <ModeBadge mode={s.mode} />
          </div>
          <div className="num mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted">
            <span>#{s.id.toString()}</span>
            <span>{s.slug}/</span>
            <span>created {dateTime(tsMs(s.createdAt))}</span>
            <span title={s.owner.toHexString()}>owner {mine ? 'you' : shortHex(s.owner.toHexString())}</span>
          </div>
          {s.statusReason && <div className="mt-1 text-xs text-ink-2">{s.statusReason}</div>}
          {s.mode === 'live' && !s.liveApproved && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded border border-serious/50 bg-serious/10 px-2 py-1 text-xs text-serious">
              <span aria-hidden>◷</span> Live mode is awaiting admin approval —{' '}
              <Link href="/settings" className="underline">
                approval queue
              </Link>
            </div>
          )}
        </div>
        <SessionControls session={s} full />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="Equity" value={usd(s.equityUsd)} />
        <Stat
          label="PnL vs bankroll"
          value={<span className={pnlClass(pnl)}>{signedPct(s.bankrollUsd > 0 ? pnl / s.bankrollUsd : 0)}</span>}
          sub={<span className={pnlClass(pnl)}>{signedUsd(pnl)}</span>}
        />
        <Stat label="Cash" value={usd(s.cashUsd)} sub={`bankroll ${usd(s.bankrollUsd, 0)}`} />
        <Stat label="Realized PnL" value={<span className={pnlClass(s.realizedPnlUsd)}>{signedUsd(s.realizedPnlUsd)}</span>} />
        <Stat label="Fees paid" value={usd(s.feesPaidUsd)} />
        <Stat label="Drawdown" value={pct(drawdown(s))} sub={`stop at ${pct(s.risk.maxDrawdownPct, 0)}`} />
        <Stat label="Exposure" value={usd(s.exposureUsd)} sub={s.equityUsd > 0 ? `${pct(s.exposureUsd / s.equityUsd)} of equity` : undefined} />
        <Stat label="Day start" value={usd(s.dayStartEquityUsd)} sub={`peak ${usd(s.peakEquityUsd)}`} />
      </div>
    </header>
  );
}

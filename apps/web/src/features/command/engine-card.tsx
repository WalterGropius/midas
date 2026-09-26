'use client';

import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import type { EngineHeartbeat } from '@midas/stdb-bindings/types';
import { Card, Empty } from '@/components/ui';
import { relTime, tsMs } from '@/lib/format';
import { useNow } from '@/lib/stdb';

export const ONLINE_MS = 60_000;

/** Heartbeat `info` is free text; engines usually send JSON. */
function parseInfo(info: string): [string, string][] | null {
  if (!info.trim().startsWith('{')) return null;
  try {
    const o = JSON.parse(info) as Record<string, unknown>;
    return Object.entries(o).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
  } catch {
    return null;
  }
}

export function EngineCard() {
  const [beats, ready] = useTable(tables.engineHeartbeat);
  const now = useNow(5000);
  const sorted = [...beats].sort((a, b) => tsMs(b.lastSeen) - tsMs(a.lastSeen));
  const online = sorted.filter(b => now - tsMs(b.lastSeen) < ONLINE_MS);
  const isOnline = online.length > 0;
  const last = sorted[0];

  return (
    <Card
      title="Engine"
      right={
        <span className={isOnline ? 'text-good' : 'text-crit'}>
          <span aria-hidden>{isOnline ? '●' : '○'}</span> {isOnline ? `online · ${online.length} worker${online.length === 1 ? '' : 's'}` : 'offline'}
        </span>
      }
    >
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : sorted.length === 0 ? (
        <Empty title="No engine has checked in yet">
          Start it with <code className="num">npm run engine</code> (or deploy to Modal). Workers heartbeat every few seconds; the
          UI shows them online while the last beat is under 60 s old.
        </Empty>
      ) : (
        <div className="space-y-2">
          {!isOnline && last && (
            <div className="text-xs text-crit">Last heartbeat {relTime(tsMs(last.lastSeen), now)} — no worker is running.</div>
          )}
          <ul className="divide-y divide-line">
            {sorted.slice(0, 6).map(b => (
              <Worker key={b.workerId} b={b} now={now} />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Worker({ b, now }: { b: EngineHeartbeat; now: number }) {
  const seen = tsMs(b.lastSeen);
  const alive = now - seen < ONLINE_MS;
  const info = parseInfo(b.info);
  return (
    <li className="py-1.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        <span className={alive ? 'text-good' : 'text-muted'} aria-hidden>
          {alive ? '●' : '○'}
        </span>
        <span className="num min-w-0 truncate text-ink">{b.workerId}</span>
        <span className="text-muted">{b.status}</span>
        <span className="num text-ink-2">{b.inflight} in flight</span>
        <span className="num text-muted">v{b.version}</span>
        <span className="num ml-auto text-muted">{relTime(seen, now)}</span>
      </div>
      {b.info &&
        (info ? (
          <div className="num mt-0.5 flex flex-wrap gap-x-3 pl-5 text-[11px] text-muted">
            {info.slice(0, 8).map(([k, v]) => (
              <span key={k}>
                {k} <span className="text-ink-2">{v.length > 40 ? `${v.slice(0, 40)}…` : v}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-0.5 truncate pl-5 text-[11px] text-muted" title={b.info}>
            {b.info}
          </div>
        ))}
    </li>
  );
}

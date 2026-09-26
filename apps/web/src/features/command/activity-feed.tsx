'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import type { Activity } from '@midas/stdb-bindings/types';
import { LevelTag } from '@/components/status';
import { Card, Empty, Segmented } from '@/components/ui';
import { dateTime, relTime, tsMs } from '@/lib/format';
import { useNow } from '@/lib/stdb';

type Filter = 'all' | 'warn' | 'error';

/** Activity log, newest first. `sessionId` scopes it to one session (+ global rows off). */
export function ActivityFeed({ sessionId, limit = 80 }: { sessionId?: bigint; limit?: number }) {
  const q = useMemo(
    () => (sessionId === undefined ? tables.activity : tables.activity.where(r => r.sessionId.eq(sessionId))),
    [sessionId]
  );
  const [rows, ready] = useTable(q);
  const [sessions] = useTable(tables.session);
  const [filter, setFilter] = useState<Filter>('all');
  const now = useNow(10_000);
  const names = useMemo(() => new Map(sessions.map(s => [s.id.toString(), s.name])), [sessions]);

  const shown = rows
    .filter(a => filter === 'all' || (filter === 'warn' ? a.level === 'warn' || a.level === 'error' : a.level === 'error'))
    .sort((a, b) => Number(b.ts.microsSinceUnixEpoch - a.ts.microsSinceUnixEpoch))
    .slice(0, limit);

  return (
    <Card
      title="Activity"
      right={
        <Segmented
          label="Level"
          options={[
            { id: 'all', label: 'all' },
            { id: 'warn', label: 'warn+' },
            { id: 'error', label: 'errors' },
          ]}
          value={filter}
          onChange={setFilter}
        />
      }
    >
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : shown.length === 0 ? (
        <Empty title="Nothing logged yet">
          Session lifecycle, operator actions, trades and engine warnings land here as they happen (kept for 3 days).
        </Empty>
      ) : (
        <ul className="max-h-[480px] divide-y divide-line overflow-y-auto">
          {shown.map(a => (
            <Row key={a.id.toString()} a={a} now={now} sessionName={names.get(a.sessionId.toString())} showSession={sessionId === undefined} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function Row({ a, now, sessionName, showSession }: { a: Activity; now: number; sessionName?: string; showSession: boolean }) {
  const ms = tsMs(a.ts);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-xs sm:flex-nowrap">
      <span className="num w-16 shrink-0 text-muted" title={dateTime(ms)}>
        {relTime(ms, now)}
      </span>
      <LevelTag level={a.level} />
      {showSession &&
        (a.sessionId === 0n ? (
          <span className="w-28 shrink-0 truncate font-mono text-[11px] text-muted">global</span>
        ) : (
          <Link
            href={`/session?id=${a.sessionId.toString()}`}
            className="w-28 shrink-0 truncate text-[11px] text-ink-2 hover:text-accent"
            title={sessionName}
          >
            {sessionName ?? `#${a.sessionId.toString()}`}
          </Link>
        ))}
      <span className="w-20 shrink-0 truncate font-mono text-[11px] text-muted">{a.kind}</span>
      <span className="min-w-0 flex-1 break-words text-ink-2">{a.message}</span>
    </li>
  );
}

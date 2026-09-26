'use client';

import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import { Card, Empty, TableWrap } from '@/components/ui';
import { dateTime, relTime, shortHex, tsMs } from '@/lib/format';
import { useNow } from '@/lib/stdb';
import { ONLINE_MS } from '../command/engine-card';

export function EngineHeartbeats() {
  const [beats, ready] = useTable(tables.engineHeartbeat);
  const now = useNow(5000);
  const shown = [...beats].sort((a, b) => tsMs(b.lastSeen) - tsMs(a.lastSeen));
  return (
    <Card title={`Engine heartbeats · ${beats.length}`}>
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : shown.length === 0 ? (
        <Empty title="No heartbeats">Each engine worker writes a heartbeat every few seconds; rows older than a day are pruned.</Empty>
      ) : (
        <TableWrap>
          <table className="tbl min-w-[760px]">
            <thead>
              <tr>
                <th>Worker</th>
                <th>Status</th>
                <th className="r">In flight</th>
                <th>Version</th>
                <th>Identity</th>
                <th className="r">Last seen</th>
                <th>Info</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(b => {
                const seen = tsMs(b.lastSeen);
                const alive = now - seen < ONLINE_MS;
                return (
                  <tr key={b.workerId} className={alive ? undefined : 'opacity-60'}>
                    <td className="num text-ink">
                      <span aria-hidden className={alive ? 'text-good' : 'text-muted'}>
                        {alive ? '●' : '○'}
                      </span>{' '}
                      {b.workerId}
                    </td>
                    <td className="text-ink-2">{b.status}</td>
                    <td className="num r">{b.inflight}</td>
                    <td className="num text-ink-2">{b.version}</td>
                    <td className="num text-muted" title={b.identity.toHexString()}>
                      {shortHex(b.identity.toHexString())}
                    </td>
                    <td className="num r text-ink-2" title={dateTime(seen)}>
                      {relTime(seen, now)}
                    </td>
                    <td className="num max-w-[360px] truncate text-[11px] text-muted" title={b.info}>
                      {b.info}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

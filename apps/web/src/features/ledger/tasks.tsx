'use client';

import { useMemo, useState } from 'react';
import type { AgentTask } from '@midas/stdb-bindings/types';
import { TaskStatus } from '@/components/status';
import { Card, Empty, Expandable, TableWrap, cx } from '@/components/ui';
import { compact, dateTime, duration, int, relTime, tsMs, usdFine } from '@/lib/format';
import { useNow } from '@/lib/stdb';

const STATUSES = ['blocked', 'pending', 'running', 'done', 'failed', 'cancelled'];

export function TaskMatrix({ tasks, ready }: { tasks: readonly AgentTask[]; ready: boolean }) {
  const { kinds, cell, totals } = useMemo(() => {
    const cell = new Map<string, number>();
    const totals = new Map<string, number>();
    for (const t of tasks) {
      cell.set(`${t.kind}|${t.status}`, (cell.get(`${t.kind}|${t.status}`) ?? 0) + 1);
      totals.set(t.status, (totals.get(t.status) ?? 0) + 1);
    }
    const kinds = [...new Set(tasks.map(t => t.kind))].sort();
    return { kinds, cell, totals };
  }, [tasks]);

  return (
    <Card title={`Tasks by kind × status · ${tasks.length}`}>
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : kinds.length === 0 ? (
        <Empty title="The ledger is empty">
          The engine enqueues tasks (triage, swarm forecasts, pro reviews, wiki compiles, coaching…) as news arrives; finished tasks are
          kept for 7 days.
        </Empty>
      ) : (
        <TableWrap>
          <table className="tbl min-w-[620px]">
            <thead>
              <tr>
                <th>Kind</th>
                {STATUSES.map(s => (
                  <th key={s} className="r">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {kinds.map(k => (
                <tr key={k}>
                  <td className="font-mono text-[12px] text-ink">{k}</td>
                  {STATUSES.map(s => {
                    const n = cell.get(`${k}|${s}`) ?? 0;
                    return (
                      <td key={s} className={cx('num r', n === 0 ? 'text-line-strong' : s === 'failed' ? 'text-crit' : 'text-ink')}>
                        {n === 0 ? '·' : int(n)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <td className="text-muted">total</td>
                {STATUSES.map(s => (
                  <td key={s} className="num r text-ink-2">
                    {int(totals.get(s) ?? 0)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

export function TaskTable({ tasks, ready }: { tasks: readonly AgentTask[]; ready: boolean }) {
  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('all');
  const now = useNow(15_000);
  const kinds = useMemo(() => [...new Set(tasks.map(t => t.kind))].sort(), [tasks]);
  const shown = tasks
    .filter(t => (status === 'all' || t.status === status) && (kind === 'all' || t.kind === kind))
    .sort((a, b) => Number(b.updatedAt.microsSinceUnixEpoch - a.updatedAt.microsSinceUnixEpoch))
    .slice(0, 150);

  return (
    <Card
      title="Recent tasks"
      right={
        <>
          <select className="max-w-[220px] rounded-md border border-line bg-bg px-2 py-0.5 text-xs text-ink-2" value={kind} onChange={e => setKind(e.target.value)} aria-label="Kind">
            <option value="all">all kinds</option>
            {kinds.map(k => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select className="max-w-[220px] rounded-md border border-line bg-bg px-2 py-0.5 text-xs text-ink-2" value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
            <option value="all">all statuses</option>
            {STATUSES.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </>
      }
    >
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : shown.length === 0 ? (
        <Empty title="No tasks match">Tasks appear as soon as the engine enqueues work.</Empty>
      ) : (
        <TableWrap>
          <table className="tbl min-w-[1100px]">
            <thead>
              <tr>
                <th>Updated</th>
                <th>Kind</th>
                <th>Status</th>
                <th className="r">Tries</th>
                <th>Model</th>
                <th className="r">Tok in / out / cached</th>
                <th className="r">Cost</th>
                <th className="r">Duration</th>
                <th>Error</th>
                <th>Dedupe key</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(t => {
                const upd = tsMs(t.updatedAt);
                const dur = upd - tsMs(t.createdAt);
                const open = t.status === 'running' || t.status === 'pending' || t.status === 'blocked';
                return (
                  <tr key={t.id.toString()}>
                    <td className="num whitespace-nowrap text-muted" title={dateTime(upd)}>
                      {relTime(upd, now)}
                    </td>
                    <td className="font-mono text-[12px] text-ink">
                      {t.kind}
                      {t.sessionId !== 0n && <span className="ml-1 text-muted">#{t.sessionId.toString()}</span>}
                    </td>
                    <td>
                      <TaskStatus status={t.status} />
                      {t.status === 'running' && t.leaseOwner && <div className="num text-[10.5px] text-muted">{t.leaseOwner}</div>}
                    </td>
                    <td className="num r">
                      {t.attempts}/{t.maxAttempts}
                    </td>
                    <td className="font-mono text-[11px] text-ink-2">{t.model || '—'}</td>
                    <td className="num r text-ink-2">
                      {t.tokensIn || t.tokensOut ? `${compact(t.tokensIn)} / ${compact(t.tokensOut)} / ${compact(t.cachedTokens)}` : '—'}
                    </td>
                    <td className="num r">{t.costUsd > 0 ? usdFine(t.costUsd) : '—'}</td>
                    <td className="num r text-ink-2" title={open ? 'age so far' : 'created → last update'}>
                      {open ? `${duration(now - tsMs(t.createdAt))}…` : duration(dur)}
                    </td>
                    <td className="max-w-[260px] text-[11.5px] text-crit">{t.error ? <Expandable text={t.error} n={80} /> : null}</td>
                    <td className="num max-w-[220px] truncate text-[11px] text-muted" title={t.dedupeKey}>
                      {t.dedupeKey}
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

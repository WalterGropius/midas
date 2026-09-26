'use client';

import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '@midas/stdb-bindings';
import { Button, Card, Empty, ErrorText, Pill, TableWrap } from '@/components/ui';
import { dateTime, relTime, shortHex, tsMs } from '@/lib/format';
import { sameIdentity, useAction, useMyRole, useNow } from '@/lib/stdb';

/** Operators: trust-on-first-use per role; later claims become requests an admin resolves. */
export function OperatorsCard() {
  const { identity } = useSpacetimeDB();
  const [ops, ready] = useTable(tables.operator);
  const [requests] = useTable(tables.operatorRequest);
  const { role } = useMyRole();
  const claim = useReducer(reducers.claimOperator);
  const resolve = useReducer(reducers.resolveOperatorRequest);
  const { run, pending, error, clear } = useAction();
  const now = useNow(30_000);
  const isAdmin = role === 'admin';
  const adminTaken = ops.some(o => o.role === 'admin');
  const myPending = requests.find(r => sameIdentity(r.identity, identity) && r.status === 'pending');
  const open = requests.filter(r => r.status === 'pending').sort((a, b) => Number(a.id - b.id));
  const recent = requests.filter(r => r.status !== 'pending').sort((a, b) => Number(b.id - a.id)).slice(0, 5);

  return (
    <Card title="Operators">
      <div className="space-y-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ink-2">Your role:</span>
          {role ? <Pill className="text-ink">{role}</Pill> : <span className="text-muted">none (viewer — you can run your own sessions)</span>}
          {!isAdmin && (
            <Button size="sm" variant={adminTaken ? 'default' : 'primary'} disabled={pending || !!myPending} onClick={() => void run(() => claim({ role: 'admin' }))}>
              {myPending ? 'Admin request pending…' : adminTaken ? 'Request admin' : 'Claim admin'}
            </Button>
          )}
        </div>
        <p className="text-muted">
          {adminTaken
            ? 'An admin exists. Asking again creates a request the current admin approves or rejects below.'
            : 'No admin yet: the first identity to claim it wins. Do this right after publishing the module.'}{' '}
          The engine claims the <span className="font-mono">engine</span> role on its first boot.
        </p>
        <ErrorText error={error} onClose={clear} />

        {!ready ? (
          <div className="text-muted">subscribing…</div>
        ) : ops.length === 0 ? (
          <Empty title="No operators">Nobody has claimed admin or engine yet.</Empty>
        ) : (
          <TableWrap>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Identity</th>
                  <th>Role</th>
                  <th className="r">Since</th>
                </tr>
              </thead>
              <tbody>
                {ops.map(o => (
                  <tr key={o.identity.toHexString()}>
                    <td className="num text-ink" title={o.identity.toHexString()}>
                      {shortHex(o.identity.toHexString(), 16)}
                      {sameIdentity(o.identity, identity) && <span className="ml-1.5 font-sans text-accent">(you)</span>}
                    </td>
                    <td className="font-mono text-[11px] uppercase">{o.role}</td>
                    <td className="num r text-muted" title={dateTime(tsMs(o.createdAt))}>
                      {relTime(tsMs(o.createdAt), now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}

        <div>
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">Pending requests · {open.length}</div>
          {open.length === 0 ? (
            <div className="text-muted">None.</div>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {open.map(r => (
                <li key={r.id.toString()} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="num text-ink" title={r.identity.toHexString()}>
                    {shortHex(r.identity.toHexString(), 16)}
                  </span>
                  <span className="text-muted">wants</span>
                  <span className="font-mono uppercase">{r.role}</span>
                  <span className="num text-muted">{relTime(tsMs(r.createdAt), now)}</span>
                  <span className="ml-auto flex gap-1.5">
                    <Button size="sm" disabled={!isAdmin || pending} title={isAdmin ? undefined : 'Admins only'} onClick={() => void run(() => resolve({ requestId: r.id, approve: true }))}>
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!isAdmin || pending} onClick={() => void run(() => resolve({ requestId: r.id, approve: false }))}>
                      Reject
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {recent.length > 0 && (
            <div className="mt-2 space-y-0.5 text-[11px] text-muted">
              {recent.map(r => (
                <div key={r.id.toString()}>
                  {shortHex(r.identity.toHexString())} → {r.role}: {r.status}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

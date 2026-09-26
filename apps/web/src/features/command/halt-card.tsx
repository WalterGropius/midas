'use client';

import Link from 'next/link';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '@midas/stdb-bindings';
import { Button, Card, ErrorText } from '@/components/ui';
import { relTime, tsMs } from '@/lib/format';
import { useAction, useMyRole, useNow } from '@/lib/stdb';

/** Global kill switch: global_flag 'halt_all'. Operators only (server-enforced). */
export function HaltCard() {
  const [flags, ready] = useTable(tables.globalFlag);
  const setFlag = useReducer(reducers.setFlag);
  const { role } = useMyRole();
  const { run, pending, error, clear } = useAction();
  const now = useNow(10_000);
  const flag = flags.find(f => f.key === 'halt_all');
  const halted = flag?.value === 'true';
  const isOperator = role === 'admin' || role === 'engine';

  const toggle = () => {
    if (halted && !window.confirm('Lift the global halt? Running sessions resume placing orders.')) return;
    void run(() => setFlag({ key: 'halt_all', value: halted ? 'false' : 'true' }));
  };

  return (
    <Card title="Global halt">
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <span className={halted ? 'text-crit' : 'text-good'} aria-hidden>
            {halted ? '✕' : '●'}
          </span>
          <span className="text-sm font-medium">{!ready ? '…' : halted ? 'HALTED — no orders anywhere' : 'Trading allowed'}</span>
        </div>
        {flag && <div className="text-[11px] text-muted">changed {relTime(tsMs(flag.updatedAt), now)}</div>}
        <Button variant={halted ? 'default' : 'danger'} className="w-full" disabled={pending || !ready} onClick={toggle}>
          {halted ? '▶ Lift halt' : '✕ HALT ALL TRADING'}
        </Button>
        {!isOperator && (
          <div className="text-[11px] text-muted">
            Only operators (admin / engine) can flip this. <Link className="text-accent hover:underline" href="/settings">Claim admin</Link>{' '}
            on a fresh deployment.
          </div>
        )}
        <ErrorText error={error} onClose={clear} />
      </div>
    </Card>
  );
}

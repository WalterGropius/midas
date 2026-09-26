'use client';

import { useSpacetimeDB, useReducer } from 'spacetimedb/react';
import { reducers } from '@midas/stdb-bindings';
import type { Session } from '@midas/stdb-bindings/types';
import { Button, ErrorText } from '@/components/ui';
import { sameIdentity, useAction, useMyRole } from '@/lib/stdb';

/** Pause / resume / stop (+ kill / archive in full mode) via setSessionStatus. */
export function SessionControls({ session, full = false }: { session: Session; full?: boolean }) {
  const { identity } = useSpacetimeDB();
  const { role } = useMyRole();
  const setStatus = useReducer(reducers.setSessionStatus);
  const { run, pending, error, clear } = useAction();
  const mine = sameIdentity(session.owner, identity);
  const canControl = mine || role === 'admin' || role === 'engine';
  const s = session.status;
  const blockedLive = session.mode === 'live' && !session.liveApproved;

  const go = (status: string, reason: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    void run(() => setStatus({ sessionId: session.id, status, reason }));
  };

  const title = canControl ? undefined : 'Only the session owner or an operator can control this session';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {s === 'running' && (
          <Button
            size="sm"
            disabled={!canControl || pending}
            title={title ?? 'No new positions; open ones keep their targets and stops'}
            onClick={() => go('paused', 'paused from UI')}
          >
            ❚❚ Pause
          </Button>
        )}
        {(s === 'paused' || s === 'stopped') && (
          <Button
            size="sm"
            disabled={!canControl || pending || blockedLive}
            title={blockedLive ? 'Live sessions need admin approval before they can run' : title}
            onClick={() => go('running', 'resumed from UI')}
          >
            ▶ Resume
          </Button>
        )}
        {(s === 'running' || s === 'paused' || s === 'pending_approval') && (
          <Button size="sm" disabled={!canControl || pending} title={title} onClick={() => go('stopped', 'stopped from UI', `Stop "${session.name}"? The engine closes its open positions and opens no new ones.`)}>
            ■ Stop
          </Button>
        )}
        {full && s !== 'killed' && s !== 'archived' && (
          <Button
            size="sm"
            variant="danger"
            disabled={!canControl || pending}
            title={title}
            onClick={() =>
              go(
                'killed',
                'kill switch from UI',
                `Kill "${session.name}"? The engine stops trading it immediately and closes its open positions at market.`
              )
            }
          >
            ✕ Kill
          </Button>
        )}
        {full && s === 'archived' && (
          <Button size="sm" variant="ghost" disabled={!canControl || pending} title={title} onClick={() => go('stopped', 'unarchived from UI')}>
            ▣ Unarchive
          </Button>
        )}
        {full && (s === 'stopped' || s === 'killed') && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!canControl || pending}
            title={title}
            onClick={() => go('archived', 'archived from UI', `Archive "${session.name}"? It disappears from the command center.`)}
          >
            ▣ Archive
          </Button>
        )}
      </div>
      <ErrorText error={error} onClose={clear} />
    </div>
  );
}

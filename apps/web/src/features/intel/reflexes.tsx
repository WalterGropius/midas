'use client';

import { useState } from 'react';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '@midas/stdb-bindings';
import type { Reflex } from '@midas/stdb-bindings/types';
import { Card, Empty, ErrorText, Pill, TableWrap, cx } from '@/components/ui';
import { fixed, int, pct, relTime, tsMs } from '@/lib/format';
import { useAction, useMyRole, useNow } from '@/lib/stdb';

/** System-1 reflexes: typed fast questions, tuned by the coach. Admins can switch them off. */
export function ReflexPanel() {
  const [rows, ready] = useTable(tables.reflex);
  const { role } = useMyRole();
  const setEnabled = useReducer(reducers.setReflexEnabled);
  const { run, pending, error, clear } = useAction();
  const shown = [...rows].sort((a, b) => a.key.localeCompare(b.key));
  const isAdmin = role === 'admin';

  return (
    <Card title={`System-1 reflexes · ${rows.filter(r => r.enabled).length}/${rows.length} on`}>
      <div className="space-y-2">
        <ErrorText error={error} onClose={clear} />
        {!ready ? (
          <div className="text-xs text-muted">subscribing…</div>
        ) : shown.length === 0 ? (
          <Empty title="No reflexes registered">
            The engine upserts its default reflex set (relevance, direction, urgency, novelty, escalation, exit, entity match, grounding,
            staleness) on boot.
          </Empty>
        ) : (
          <TableWrap>
            <table className="tbl min-w-[980px]">
              <thead>
                <tr>
                  <th>Reflex</th>
                  <th>Provider</th>
                  <th className="r">Threshold</th>
                  <th className="r">Fired</th>
                  <th className="r">Resolved</th>
                  <th className="r">Brier</th>
                  <th className="r">Hit rate</th>
                  <th className="r">Latency</th>
                  <th>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(r => (
                  <ReflexRow
                    key={r.key}
                    r={r}
                    canToggle={isAdmin && !pending}
                    onToggle={() => void run(() => setEnabled({ key: r.key, enabled: !r.enabled }))}
                  />
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {!isAdmin && rows.length > 0 && <div className="text-[11px] text-muted">Only admins can switch reflexes on or off.</div>}
      </div>
    </Card>
  );
}

function ReflexRow({ r, canToggle, onToggle }: { r: Reflex; canToggle: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false);
  const now = useNow(60_000);
  const hasCandidate = r.candidateInstructions.trim().length > 0;
  return (
    <>
      <tr className={cx(!r.enabled && 'opacity-55')}>
        <td>
          <button type="button" className="text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
            <span className="font-mono text-[12.5px] text-ink hover:text-accent">{r.key}</span>
            <span className="ml-2 text-[11px] text-muted">
              {r.qtype} · v{r.version}
            </span>
            {hasCandidate && <Pill className="ml-2">candidate</Pill>}
          </button>
        </td>
        <td className="font-mono text-[11px] text-ink-2">{r.provider}</td>
        <td className="num r">{fixed(r.threshold, 2)}</td>
        <td className="num r">{int(r.nFired)}</td>
        <td className="num r">{int(r.nResolved)}</td>
        <td className="num r">{r.nResolved > 0 ? fixed(r.brier, 3) : '—'}</td>
        <td className="num r">{r.nResolved > 0 ? pct(r.hitRate, 0) : '—'}</td>
        <td className="num r">{r.avgLatencyMs > 0 ? `${fixed(r.avgLatencyMs, 0)} ms` : '—'}</td>
        <td>
          <button
            type="button"
            role="switch"
            aria-checked={r.enabled}
            aria-label={`${r.key} enabled`}
            disabled={!canToggle}
            onClick={onToggle}
            className={cx(
              'relative inline-flex h-4 w-7 items-center rounded-full border transition-colors disabled:cursor-not-allowed',
              r.enabled ? 'border-accent bg-accent/70' : 'border-line-strong bg-bg'
            )}
          >
            <span className={cx('inline-block h-3 w-3 rounded-full bg-ink transition-transform', r.enabled ? 'translate-x-3' : 'translate-x-0.5')} />
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} className="bg-bg">
            <div className="grid gap-3 py-1 text-xs md:grid-cols-2">
              <div>
                <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">Instructions (v{r.version})</div>
                <p className="whitespace-pre-wrap text-ink-2">{r.instructions}</p>
                {r.criteriaKeys.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-ink-2">
                    {r.criteriaKeys.map((k, i) => (
                      <li key={k}>
                        <span className="font-mono text-ink">{k}</span> — {r.criteriaText[i]}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-1 text-[11px] text-muted">updated {relTime(tsMs(r.updatedAt), now)}</div>
              </div>
              <div className="space-y-2">
                <div>
                  <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">Coach note</div>
                  <p className="whitespace-pre-wrap text-ink-2">{r.coachNote || '—'}</p>
                </div>
                {hasCandidate && (
                  <div>
                    <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">
                      Candidate on trial · threshold {fixed(r.candidateThreshold, 2)}
                    </div>
                    <p className="whitespace-pre-wrap text-ink-2">{r.candidateInstructions}</p>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

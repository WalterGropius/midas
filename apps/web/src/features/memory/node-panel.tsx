'use client';

import type { MemEdge, MemNode } from '@midas/stdb-bindings/types';
import { Empty, Pill } from '@/components/ui';
import { dateTime, fixed, int, tsMs } from '@/lib/format';
import { Glyph, kindStyle } from './graph-view';

export function NodePanel({
  node,
  edges,
  nodesById,
  onSelect,
}: {
  node: MemNode | undefined;
  edges: readonly MemEdge[];
  nodesById: Map<string, MemNode>;
  onSelect: (id: string) => void;
}) {
  if (!node) {
    return (
      <Empty title="Click a node">
        Entities, events, markets and lessons the agents extracted from news and outcomes. Edges are bi-temporal facts: when they became true,
        and when (if ever) they stopped being true.
      </Empty>
    );
  }
  const st = kindStyle(node.kind);
  const id = node.id;
  const incident = edges
    .filter(e => e.src === id || e.dst === id)
    .sort((a, b) => Number(b.validFrom.microsSinceUnixEpoch - a.validFrom.microsSinceUnixEpoch));

  return (
    <div className="space-y-3 text-xs">
      <div>
        <div className="flex items-center gap-2">
          <svg width={14} height={14} aria-hidden>
            <Glyph shape={st.shape} x={7} y={7} r={5} fill={st.color} />
          </svg>
          <h2 className="min-w-0 break-words text-[15px] font-medium text-ink">{node.label}</h2>
        </div>
        <div className="num mt-1 break-all text-[11px] text-muted">{node.key}</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Pill>{node.kind}</Pill>
          <Pill>{node.status}</Pill>
          <Pill>{node.sessionId === 0n ? 'global' : `session #${node.sessionId.toString()}`}</Pill>
        </div>
      </div>
      {node.summary && <p className="whitespace-pre-wrap leading-relaxed text-ink-2">{node.summary}</p>}
      <dl className="num grid grid-cols-2 gap-x-3 gap-y-1">
        <dt className="font-sans text-muted">salience</dt>
        <dd>{fixed(node.salience, 3)}</dd>
        <dt className="font-sans text-muted">mentions</dt>
        <dd>{int(node.mentionCount)}</dd>
        {node.kind === 'lesson' && (
          <>
            <dt className="font-sans text-muted">helpful / harmful</dt>
            <dd>
              {node.helpful} / {node.harmful}
            </dd>
          </>
        )}
        <dt className="font-sans text-muted">updated</dt>
        <dd>{dateTime(tsMs(node.updatedAt))}</dd>
      </dl>
      {node.aliases.length > 0 && (
        <div>
          <div className="mb-0.5 text-[10.5px] uppercase tracking-wide text-muted">Aliases</div>
          <div className="flex flex-wrap gap-1">
            {node.aliases.map(a => (
              <span key={a} className="rounded bg-surface-2 px-1.5 py-0.5 text-ink-2">
                {a}
              </span>
            ))}
          </div>
        </div>
      )}
      <div>
        <div className="mb-1 text-[10.5px] uppercase tracking-wide text-muted">Edges · {incident.length}</div>
        {incident.length === 0 ? (
          <div className="text-muted">No edges.</div>
        ) : (
          <ul className="max-h-[420px] space-y-1.5 overflow-y-auto">
            {incident.map(e => {
              const out = e.src === id;
              const other = nodesById.get((out ? e.dst : e.src).toString());
              const invalid = e.invalidatedAt !== undefined;
              return (
                <li key={e.id.toString()} className={`rounded-md border border-line p-2 ${invalid ? 'opacity-60' : ''}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted">{out ? '→' : '←'}</span>
                    <span className="font-mono text-[11px] text-ink">{e.rel}</span>
                    <button
                      type="button"
                      className="min-w-0 truncate text-left text-accent hover:underline"
                      onClick={() => other && onSelect(other.id.toString())}
                      disabled={!other}
                    >
                      {other?.label ?? `node ${(out ? e.dst : e.src).toString()}`}
                    </button>
                  </div>
                  <div className="num mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
                    <span>w {fixed(e.weight, 2)}</span>
                    {e.value !== 0 && <span>value {fixed(e.value, 3)}</span>}
                    {e.lagMin > 0 && <span>lag {fixed(e.lagMin, 0)}m</span>}
                    <span>{e.status}</span>
                    <span>from {dateTime(tsMs(e.validFrom))}</span>
                    {invalid && <span className="text-ink-2">invalidated {dateTime(tsMs(e.invalidatedAt!))}</span>}
                  </div>
                  {e.evidence && <div className="mt-0.5 text-[11px] text-ink-2">{e.evidence}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

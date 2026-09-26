'use client';

import { useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import { Card, Empty, cx, inputCls } from '@/components/ui';
import { GraphView, Glyph, KIND_STYLE } from '@/features/memory/graph-view';
import { NodePanel } from '@/features/memory/node-panel';

const MAX_NODES = 400;
const KINDS = Object.keys(KIND_STYLE);

export default function MemoryPage() {
  const [nodes, nodesReady] = useTable(tables.memNode);
  const [edges] = useTable(tables.memEdge);
  const [sessions] = useTable(tables.session);
  const [kinds, setKinds] = useState<Set<string>>(new Set(KINDS));
  const [query, setQuery] = useState('');
  const [showMerged, setShowMerged] = useState(false);
  const [showInvalid, setShowInvalid] = useState(false);
  const [scope, setScope] = useState<string>('all');
  const [selected, setSelected] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const matches = (n: (typeof nodes)[number]) =>
    !!q && (n.label.toLowerCase().includes(q) || n.key.toLowerCase().includes(q) || n.aliases.some(a => a.toLowerCase().includes(q)));

  const { shownNodes, shownEdges, hits, total } = useMemo(() => {
    const pool = nodes.filter(
      n =>
        (kinds.has(n.kind) || (!KINDS.includes(n.kind) && kinds.size === KINDS.length)) &&
        (showMerged || n.status !== 'merged') &&
        (scope === 'all' || n.sessionId.toString() === scope)
    );
    // search hits first, then the most salient, capped for a readable layout
    const ranked = [...pool].sort((a, b) => Number(matches(b)) - Number(matches(a)) || b.salience - a.salience).slice(0, MAX_NODES);
    const ids = new Set(ranked.map(n => n.id.toString()));
    const shownEdges = edges.filter(
      e => ids.has(e.src.toString()) && ids.has(e.dst.toString()) && (showInvalid || (e.invalidatedAt === undefined && e.status !== 'invalidated'))
    );
    const hits = new Set(ranked.filter(matches).map(n => n.id.toString()));
    // stable order keeps the force layout from reshuffling on every update
    ranked.sort((a, b) => Number(a.id - b.id));
    return { shownNodes: ranked, shownEdges, hits, total: pool.length };
  }, [nodes, edges, kinds, showMerged, showInvalid, scope, q]);

  const nodesById = useMemo(() => new Map(nodes.map(n => [n.id.toString(), n])), [nodes]);
  const counts = useMemo(() => nodes.reduce<Record<string, number>>((m, n) => ((m[n.kind] = (m[n.kind] ?? 0) + 1), m), {}), [nodes]);
  const scopes = useMemo(() => [...new Set(nodes.map(n => n.sessionId.toString()))].sort((a, b) => Number(a) - Number(b)), [nodes]);
  const sessionName = (id: string) => (id === '0' ? 'global memory' : sessions.find(s => s.id.toString() === id)?.name ?? `session #${id}`);

  const toggleKind = (k: string) =>
    setKinds(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold">Memory</h1>
        <p className="text-xs text-muted">
          The knowledge graph agents retrieve from before forecasting — showing the {MAX_NODES} most salient nodes that match the filters.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className={cx(inputCls, 'max-w-[260px]')}
          placeholder="Search label, key or alias…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          aria-label="Search nodes"
        />
        <div className="flex flex-wrap gap-1" role="group" aria-label="Node kinds">
          {KINDS.map(k => {
            const st = KIND_STYLE[k];
            const on = kinds.has(k);
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => toggleKind(k)}
                className={cx('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', on ? 'border-line-strong bg-surface-2 text-ink' : 'border-line text-muted')}
              >
                <svg width={12} height={12} aria-hidden>
                  <Glyph shape={st.shape} x={6} y={6} r={4.2} fill={on ? st.color : 'var(--line-strong)'} />
                </svg>
                {st.label}
                <span className="num text-muted">{counts[k] ?? 0}</span>
              </button>
            );
          })}
        </div>
        <select className="max-w-[220px] rounded-md border border-line bg-bg px-2 py-1 text-xs text-ink-2" value={scope} onChange={e => setScope(e.target.value)} aria-label="Scope">
          <option value="all">all scopes</option>
          {scopes.map(s => (
            <option key={s} value={s}>
              {sessionName(s)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" className="accent-[var(--accent)]" checked={showMerged} onChange={e => setShowMerged(e.target.checked)} />
          merged nodes
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" className="accent-[var(--accent)]" checked={showInvalid} onChange={e => setShowInvalid(e.target.checked)} />
          invalidated edges
        </label>
        <span className="num ml-auto text-[11px] text-muted">
          {shownNodes.length}/{total} nodes · {shownEdges.length} edges{q && ` · ${hits.size} matches`}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        {!nodesReady ? (
          <div className="flex h-[620px] items-center justify-center rounded-lg border border-line text-xs text-muted">subscribing to memory…</div>
        ) : shownNodes.length === 0 ? (
          <Empty title={nodes.length === 0 ? 'Memory is empty' : 'Nothing matches these filters'}>
            {nodes.length === 0
              ? 'The engine writes entities, events and market nodes as it triages news, links them with typed edges, and distills lessons from resolved predictions.'
              : 'Turn more kinds back on, clear the search, or include merged nodes.'}
          </Empty>
        ) : (
          <GraphView nodes={shownNodes} edges={shownEdges} selected={selected} onSelect={setSelected} highlight={hits} />
        )}
        <Card title="Node">
          <NodePanel node={selected ? nodesById.get(selected) : undefined} edges={edges} nodesById={nodesById} onSelect={setSelected} />
        </Card>
      </div>
    </div>
  );
}

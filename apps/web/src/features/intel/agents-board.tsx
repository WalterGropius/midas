'use client';

import { useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import type { Agent } from '@midas/stdb-bindings/types';
import { Card, Empty, Expandable, Pill, Segmented, TableWrap, cx } from '@/components/ui';
import { fixed, int, pct } from '@/lib/format';

type SortKey = 'name' | 'tier' | 'generation' | 'status' | 'weight' | 'nScored' | 'brier' | 'reactionMae' | 'directionHit';

// Lower is better for errors; the default direction per column follows that.
const LOWER_BETTER: SortKey[] = ['brier', 'reactionMae'];

const COLS: { key: SortKey; label: string; right?: boolean; title?: string }[] = [
  { key: 'name', label: 'Agent' },
  { key: 'tier', label: 'Tier' },
  { key: 'generation', label: 'Gen', right: true },
  { key: 'status', label: 'Status' },
  { key: 'weight', label: 'Weight', right: true, title: 'pooling weight from online (Hedge) losses' },
  { key: 'nScored', label: 'Scored', right: true },
  { key: 'brier', label: 'Brier', right: true, title: 'mean Brier score of fair-value forecasts (lower is better)' },
  { key: 'reactionMae', label: 'Reaction MAE', right: true, title: 'mean abs. error of the predicted price move, in points (lower is better)' },
  { key: 'directionHit', label: 'Dir. hit', right: true, title: 'share of reactions with the right sign' },
];

export function AgentsBoard() {
  const [agents, ready] = useTable(tables.agent);
  const [status, setStatus] = useState<'active' | 'candidate' | 'retired' | 'all'>('active');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'weight', dir: -1 });
  const byId = useMemo(() => new Map(agents.map(a => [a.id.toString(), a])), [agents]);

  const shown = agents
    .filter(a => status === 'all' || a.status === status)
    .sort((a, b) => {
      const va = a[sort.key];
      const vb = b[sort.key];
      const c = typeof va === 'string' ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return c * sort.dir;
    });

  const onSort = (key: SortKey) =>
    setSort(s => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: LOWER_BETTER.includes(key) || key === 'name' ? 1 : -1 }));

  const counts = agents.reduce<Record<string, number>>((m, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {});

  return (
    <Card
      title={`Agents · ${agents.length}`}
      right={
        <Segmented
          label="Status"
          options={[
            { id: 'active', label: `active ${counts.active ?? 0}` },
            { id: 'candidate', label: `candidate ${counts.candidate ?? 0}` },
            { id: 'retired', label: `retired ${counts.retired ?? 0}` },
            { id: 'all', label: 'all' },
          ]}
          value={status}
          onChange={setStatus}
        />
      }
    >
      {!ready ? (
        <div className="text-xs text-muted">subscribing…</div>
      ) : shown.length === 0 ? (
        <Empty title={agents.length === 0 ? 'No agents yet' : `No ${status} agents`}>
          The engine seeds a population of Flash forecasters (different personas and niches) plus a Pro supervisor on first boot; evolution
          adds candidates and retires the weakest.
        </Empty>
      ) : (
        <TableWrap>
          <table className="tbl min-w-[1000px]">
            <thead>
              <tr>
                {COLS.map(c => (
                  <th key={c.key} className={c.right ? 'r' : undefined} title={c.title} aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" className="uppercase hover:text-ink" onClick={() => onSort(c.key)}>
                      {c.label}
                      {sort.key === c.key && <span aria-hidden> {sort.dir === 1 ? '↑' : '↓'}</span>}
                    </button>
                  </th>
                ))}
                <th>Lineage</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(a => (
                <AgentRow key={a.id.toString()} a={a} byId={byId} />
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Card>
  );
}

function lineage(a: Agent, byId: Map<string, Agent>): string[] {
  const out: string[] = [];
  let cur = a.parentId !== 0n ? byId.get(a.parentId.toString()) : undefined;
  while (cur && out.length < 4) {
    out.push(`${cur.name} (g${cur.generation})`);
    cur = cur.parentId !== 0n ? byId.get(cur.parentId.toString()) : undefined;
  }
  return out;
}

function AgentRow({ a, byId }: { a: Agent; byId: Map<string, Agent> }) {
  const chain = lineage(a, byId);
  return (
    <tr className={cx(a.status === 'retired' && 'opacity-55')}>
      <td className="max-w-[320px]">
        <div className="font-medium text-ink">{a.name}</div>
        <div className="text-[11px] text-muted">{a.niche}</div>
        <div className="mt-0.5 text-[11.5px] text-ink-2">
          <Expandable text={a.persona} n={90} />
        </div>
      </td>
      <td>
        <Pill>{a.tier}</Pill>
      </td>
      <td className="num r">{a.generation}</td>
      <td className="font-mono text-[11px] uppercase text-ink-2">{a.status}</td>
      <td className="num r">{fixed(a.weight, 3)}</td>
      <td className="num r">{int(a.nScored)}</td>
      <td className="num r">{a.nScored > 0 ? fixed(a.brier, 3) : '—'}</td>
      <td className="num r">{a.nScored > 0 ? `${fixed(a.reactionMae * 100, 1)} pts` : '—'}</td>
      <td className="num r">{a.nScored > 0 ? pct(a.directionHit, 0) : '—'}</td>
      <td className="max-w-[240px] text-[11px] text-muted">
        {chain.length ? chain.join(' ← ') : 'founder'}
        {a.lineageNote && <div className="text-ink-2">{a.lineageNote}</div>}
      </td>
    </tr>
  );
}

'use client';

import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '@midas/stdb-bindings';
import { StatTile } from '@/components/ui';
import { compact, int, pct, usd } from '@/lib/format';
import { useUtcDayStart } from '@/lib/stdb';

/** KPI row: spend, cache, reflexes, agents, memory, task queue. */
export function GlobalStats() {
  const dayStart = useUtcDayStart();
  const usageQ = useMemo(() => tables.llmUsage.where(r => r.hour.gte(dayStart)), [dayStart]);
  const [usage] = useTable(usageQ);
  const [reflexes] = useTable(tables.reflex);
  const [agents] = useTable(tables.agent.where(r => r.status.eq('active')));
  const [nodes] = useTable(tables.memNode);
  const [edges] = useTable(tables.memEdge);
  const [openTasks] = useTable(
    tables.agentTask.where(r => r.status.eq('pending').or(r.status.eq('running')).or(r.status.eq('blocked')))
  );

  const spend = usage.reduce((s, u) => s + u.costUsd, 0);
  const calls = usage.reduce((s, u) => s + u.calls, 0);
  const tokIn = usage.reduce((s, u) => s + u.tokensIn, 0);
  const cached = usage.reduce((s, u) => s + u.cachedTokens, 0);
  const fired = reflexes.reduce((s, r) => s + r.nFired, 0);
  const tiers = agents.reduce<Record<string, number>>((m, a) => ((m[a.tier] = (m[a.tier] ?? 0) + 1), m), {});
  const liveNodes = nodes.filter(n => n.status !== 'merged');
  const liveEdges = edges.filter(e => e.invalidatedAt === undefined);
  const lessons = liveNodes.filter(n => n.kind === 'lesson').length;
  const byStatus = openTasks.reduce<Record<string, number>>((m, t) => ((m[t.status] = (m[t.status] ?? 0) + 1), m), {});

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <StatTile label="LLM spend today (UTC)" value={usd(spend)} sub={`${int(calls)} calls`} />
      <StatTile
        label="Prompt cache hit"
        value={tokIn > 0 ? pct(cached / tokIn, 0) : '—'}
        sub={tokIn > 0 ? `${compact(cached)} of ${compact(tokIn)} input tok` : 'no calls yet today'}
      />
      <StatTile
        label="Reflex firings"
        value={int(fired)}
        sub={`${reflexes.filter(r => r.enabled).length}/${reflexes.length} reflexes on`}
      />
      <StatTile
        label="Active agents"
        value={int(agents.length)}
        sub={Object.keys(tiers).length ? Object.entries(tiers).map(([k, v]) => `${v} ${k}`).join(' · ') : 'population not seeded'}
      />
      <StatTile
        label="Memory"
        value={`${compact(liveNodes.length)} / ${compact(liveEdges.length)}`}
        sub={`nodes / edges · ${lessons} lessons`}
      />
      <StatTile
        label="Open tasks"
        value={int(openTasks.length)}
        sub={`${byStatus.pending ?? 0} pending · ${byStatus.running ?? 0} running · ${byStatus.blocked ?? 0} blocked`}
      />
    </div>
  );
}

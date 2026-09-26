// Commands shared by every inbound connector (HTTP API, Telegram, future MCP).
// Each one becomes a SpacetimeDB reducer call, so every channel shares the
// same permissions and audit trail as the UI.
import type { EngineCtx } from '../ctx';
import type { Ingest } from '../intel/ingest';
import { usage } from '../llm/usage';
import { activeProviderName } from '../s1/systemone';
import { haltAll } from '../stdb';
import { readiness } from '../trade/readiness';

export function status(ctx: EngineCtx) {
  const sessions = [...ctx.conn.db.session.iter()]
    .filter(s => s.status !== 'archived')
    .map(s => ({
      id: s.id.toString(),
      name: s.name,
      status: s.status,
      mode: s.mode,
      equityUsd: Number(s.equityUsd.toFixed(2)),
      pnlPct: Number((((s.equityUsd - s.bankrollUsd) / s.bankrollUsd) * 100).toFixed(2)),
      exposureUsd: Number(s.exposureUsd.toFixed(2)),
    }));
  const tasks: Record<string, number> = {};
  for (const t of ctx.conn.db.agentTask.iter()) tasks[t.status] = (tasks[t.status] ?? 0) + 1;
  const r = readiness(ctx.conn);
  return {
    haltAll: haltAll(ctx.conn),
    systemOne: activeProviderName(),
    llmSpendTodayUsd: Number(usage.spent().toFixed(4)),
    watchedMarkets: ctx.hub.watched().size,
    sessions,
    tasks,
    liveReadiness: { ready: r.ready, reasons: r.reasons, resolved: r.resolved, brierModel: r.brierModel, brierMarket: r.brierMarket },
  };
}

export async function setStatus(ctx: EngineCtx, sessionId: string, statusValue: string, reason: string) {
  await ctx.conn.reducers.setSessionStatus({ sessionId: BigInt(sessionId), status: statusValue, reason });
}

export async function setHalt(ctx: EngineCtx, on: boolean, who: string) {
  await ctx.conn.reducers.setFlag({ key: 'halt_all', value: on ? 'true' : 'false' });
  await ctx.alerts.send('risk', `global halt ${on ? 'ON' : 'OFF'} (by ${who})`);
}

export async function pushNews(
  ingest: Ingest,
  items: { title: string; summary?: string; url?: string; source?: string; publishedAt?: string }[],
  via: string
): Promise<number> {
  return ingest.accept(
    items
      .filter(i => i.title && i.title.trim().length > 3)
      .map(i => ({
        feed: via,
        source: (i.source ?? via).slice(0, 40),
        title: i.title.trim().slice(0, 480),
        summary: (i.summary ?? '').slice(0, 3000),
        url: i.url ?? '',
        publishedMs: i.publishedAt ? Date.parse(i.publishedAt) || Date.now() : Date.now(),
      }))
  );
}

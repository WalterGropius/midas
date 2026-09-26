// Shared helpers for building intelligence context.
import type { Market, NewsItem, Session } from '@midas/stdb-bindings/types';
import type { EngineCtx } from '../ctx';
import { msFromTs } from '../util/time';

export const TRADING = new Set(['running']);

export function sessionsForMarket(ctx: EngineCtx, conditionId: string, statuses = TRADING): Session[] {
  const ids = new Set<bigint>();
  for (const sm of ctx.conn.db.sessionMarket.conditionId.filter(conditionId)) ids.add(sm.sessionId);
  return [...ids]
    .map(id => ctx.conn.db.session.id.find(id))
    .filter((s): s is Session => Boolean(s) && statuses.has(s!.status));
}

export function hoursToResolution(m: Market): number | undefined {
  const t = Date.parse(m.endDate);
  return Number.isFinite(t) ? (t - Date.now()) / 3_600_000 : undefined;
}

export function timeLeft(m: Market): string {
  const h = hoursToResolution(m);
  if (h === undefined) return 'unknown';
  if (h < 0) return 'past end date (awaiting resolution)';
  if (h < 48) return `${h.toFixed(1)} hours`;
  return `${(h / 24).toFixed(1)} days`;
}

/** Market block for prompts. No price: forecasters are blind to the crowd. */
export function marketBlock(m: Market): string {
  return [
    `MARKET: ${m.question}`,
    m.outcomeLabel ? `OUTCOME: ${m.outcomeLabel}` : '',
    `ENDS: ${m.endDate || 'unknown'} (time left: ${timeLeft(m)})`,
    `CATEGORY: ${m.category || 'n/a'}`,
    `RESOLUTION CRITERIA: ${m.description.slice(0, 1800) || 'n/a'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function newsBlock(n: NewsItem): string {
  return [
    `NEWS (${n.source}, published ${new Date(msFromTs(n.publishedAt)).toISOString()}):`,
    `HEADLINE: ${n.title}`,
    n.summary ? `SUMMARY: ${n.summary.slice(0, 1500)}` : '',
    n.url ? `URL: ${n.url}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Human operator notes and priors for a market, from every session watching it. */
export function operatorNotes(ctx: EngineCtx, conditionId: string): string {
  const lines: string[] = [];
  for (const sm of ctx.conn.db.sessionMarket.conditionId.filter(conditionId)) {
    const s = ctx.conn.db.session.id.find(sm.sessionId);
    if (!s || !TRADING.has(s.status)) continue;
    if (sm.note) lines.push(`- operator note: ${sm.note.slice(0, 400)}`);
    if (s.thesis) lines.push(`- session thesis (${s.name}): ${s.thesis.slice(0, 400)}`);
  }
  return [...new Set(lines)].slice(0, 6).join('\n');
}

export function recentHeadlines(ctx: EngineCtx, beforeMs: number, n = 12): string[] {
  return [...ctx.conn.db.newsItem.iter()]
    .filter(x => msFromTs(x.publishedAt) < beforeMs && msFromTs(x.publishedAt) > beforeMs - 24 * 3_600_000)
    .sort((a, b) => Number(b.publishedAt.microsSinceUnixEpoch - a.publishedAt.microsSinceUnixEpoch))
    .slice(0, n)
    .map(x => x.title);
}

// L2: the Flash swarm. K diverse forecasters answer the same question
// independently and BLIND to the market price; the shared context goes first
// (one cached prefix for all K calls) and each agent's style goes last. Their
// answers are combined by formula — never by another LLM.
import {
  aggregateDeltas,
  aggregateForecasts,
  applyPlatt,
  clampProb,
  deltaFromShift,
  DEFAULT_INTEL,
  priceAt,
} from '@midas/core';
import type { Agent, Market, NewsItem } from '@midas/stdb-bindings/types';
import { config } from '../config';
import type { EngineCtx } from '../ctx';
import { generateJson, geminiAvailable } from '../llm/gemini';
import { altAvailable, altModels, generateJsonAlt } from '../llm/openrouter';
import { FORECAST_SCHEMA, FORECASTER_SYSTEM, type ForecastOut } from '../llm/prompts';
import { usage } from '../llm/usage';
import { logger } from '../log';
import { keys, type MemoryContext } from '../memory/graph';
import { task, UsageSum, type Handler, type TaskInput } from '../ledger/types';
import { msFromTs, ref } from '../util/time';
import { hoursToResolution, marketBlock, newsBlock, operatorNotes, sessionsForMarket } from './common';

const log = logger('swarm');

export interface SwarmPayload {
  newsId: string;
  conditionId: string;
  relevance?: number;
  upP?: number;
  downP?: number;
  urgency?: number;
  entityKeys?: string[];
}

/** Everything a forecaster sees, in cache-friendly order (stable → volatile). */
export function sharedPrefix(market: Market, news: NewsItem, mem: MemoryContext, notes: string): string {
  const lessons = mem.lessons.slice(0, 6).map(l => `- ${l.label}: ${l.summary.slice(0, 240)}`);
  return [
    marketBlock(market),
    '',
    newsBlock(news),
    '',
    'MEMORY (retrieved; hints to verify, not facts):',
    mem.text || '(nothing relevant in memory yet)',
    lessons.length ? `\nLESSONS FROM PAST MISTAKES:\n${lessons.join('\n')}` : '',
    notes ? `\nOPERATOR CONTEXT:\n${notes}` : '',
  ]
    .filter(s => s !== undefined)
    .join('\n');
}

export function agentSuffix(a: Pick<Agent, 'persona' | 'instructions'>): string {
  return `STYLE — ${a.persona}:\n${a.instructions}\n\nAnswer as JSON.`;
}

export function pickAgents(ctx: EngineCtx, market: Market, k: number, tier = 'flash'): Agent[] {
  const cat = `${market.category} ${market.question}`.toLowerCase();
  const nicheHit = (a: Agent) =>
    a.niche === 'general' ||
    (a.niche === 'politics' && /elect|president|senate|congress|vote|party|minister|parliament/.test(cat)) ||
    (a.niche === 'economics' && /fed|rate|inflation|cpi|gdp|jobs|recession|ecb|economy/.test(cat)) ||
    (a.niche === 'crypto' && /bitcoin|btc|eth|crypto|solana|token|etf/.test(cat));
  return [...ctx.conn.db.agent.status.filter('active')]
    .filter(a => a.tier === tier)
    .sort((a, b) => Number(nicheHit(b)) - Number(nicheHit(a)) || b.weight - a.weight)
    .slice(0, k);
}

/** Price at the moment the news broke — the reference point for its reaction. */
export function priceAtNews(ctx: EngineCtx, conditionId: string, newsMs: number): number {
  const bars = ctx.hub.bars1m(conditionId, newsMs - 3 * 3_600_000);
  return priceAt(bars, newsMs) ?? ctx.hub.price(conditionId)?.mid ?? 0.5;
}

const proCalls = new Map<string, number[]>();

export function proBudgetOk(ctx: EngineCtx, conditionId: string): boolean {
  const sessions = sessionsForMarket(ctx, conditionId);
  const hourAgo = Date.now() - 3_600_000;
  return sessions.some(s => {
    const k = s.id.toString();
    const calls = (proCalls.get(k) ?? []).filter(t => t > hourAgo);
    proCalls.set(k, calls);
    return calls.length < s.intel.proCallsPerHour && usage.spentForSession(s.id) < s.intel.dailyLlmBudgetUsd;
  });
}

export function noteProCall(ctx: EngineCtx, conditionId: string) {
  for (const s of sessionsForMarket(ctx, conditionId)) {
    const k = s.id.toString();
    proCalls.set(k, [...(proCalls.get(k) ?? []), Date.now()]);
  }
}

export function consensusCalibrator(ctx: EngineCtx) {
  const c = ctx.conn.db.calibrator.component.find('consensus:resolution');
  return c && c.n >= 30 ? { a: c.a, b: c.b } : { a: config.intel.extremize, b: 0 };
}

export const swarm: Handler = async (ctx, _task, p: SwarmPayload) => {
  const news = ctx.conn.db.newsItem.id.find(BigInt(p.newsId));
  const market = ctx.hub.market(p.conditionId);
  if (!news || !market) return { result: { skipped: 'missing news or market' } };
  if (!market.active || market.resolved) return { result: { skipped: 'market inactive' } };
  if (!geminiAvailable()) return { result: { skipped: 'no GEMINI_API_KEY' } };

  const sessions = sessionsForMarket(ctx, market.conditionId);
  if (sessions.length === 0) return { result: { skipped: 'no running session watches this market' } };
  const k = Math.max(...sessions.map(s => s.intel.swarmSize), DEFAULT_INTEL.swarmSize);

  const eventKey = keys.event(news.id);
  const eventNode = ctx.graph.node(eventKey);
  const embedding = eventNode && eventNode.embedding.length > 0 ? eventNode.embedding : undefined;
  const mem = ctx.graph.context({
    entityKeys: p.entityKeys ?? [],
    marketKey: keys.market(market.conditionId),
    embedding,
    excludeKeys: [eventKey],
  });
  const prefix = sharedPrefix(market, news, mem, operatorNotes(ctx, market.conditionId));
  const agents = pickAgents(ctx, market, k);
  if (agents.length === 0) return { result: { skipped: 'no active agents' } };

  const usageSum = new UsageSum();
  // every other agent runs on another model family when one is configured
  const alts = altAvailable() ? altModels() : [];
  const answers = await Promise.all(
    agents.map(async (a, i) => {
      const t0 = Date.now();
      try {
        const alt = alts.length > 0 && i % 2 === 1 ? alts[Math.floor(i / 2) % alts.length] : undefined;
        const r = alt
          ? await generateJsonAlt<ForecastOut>({
              route: 'swarm-alt',
              model: alt,
              system: FORECASTER_SYSTEM,
              prefix,
              suffix: agentSuffix(a),
              schema: FORECAST_SCHEMA,
              sessionId: sessions[0].id,
            })
          : await generateJson<ForecastOut>({
              route: 'swarm',
              tier: 'flash',
              system: FORECASTER_SYSTEM,
              prefix,
              suffix: agentSuffix(a),
              schema: FORECAST_SCHEMA,
              thinking: 'low',
              sessionId: sessions[0].id,
            });
        usageSum.add(r);
        return { agent: a, out: r.data, latencyMs: Date.now() - t0 };
      } catch (err) {
        log.warn('forecaster failed', { agent: a.name, err: String(err) });
        return undefined;
      }
    })
  );
  const ok = answers.filter((x): x is NonNullable<typeof x> => Boolean(x) && Number.isFinite(x!.out.probYes));
  if (ok.length === 0) throw new Error('every forecaster failed');

  // ── combine by formula
  const newsMs = msFromTs(news.publishedAt);
  const p0 = priceAtNews(ctx, market.conditionId, newsMs);
  const pooled = aggregateForecasts(
    ok.map(x => ({ prob: clampProb(x.out.probYes, 0.03), weight: x.agent.weight })),
    { trim: config.intel.trim, extremize: 1 }
  );
  const fair = clampProb(applyPlatt(pooled.prob, consensusCalibrator(ctx)), 0.03);
  const shifts = aggregateDeltas(ok.map(x => ({ delta: x.out.shift, weight: x.agent.weight })));
  const halfLife = [...ok.map(x => x.out.halfLifeMin)].sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? 15;
  let expectedDelta = deltaFromShift(p0, shifts.median);
  // compounding experience: realized reactions to similar past news
  if (mem.prior.effN >= 2) {
    const w = mem.prior.effN / (mem.prior.effN + 6);
    expectedDelta = w * mem.prior.mean + (1 - w) * expectedDelta;
  }
  const signalRef = ref('sig');
  await ctx.conn.reducers.insertSignal({
    signal: {
      ref: signalRef,
      newsId: news.id,
      conditionId: market.conditionId,
      layer: 'swarm',
      expectedDelta,
      deltaQ10: deltaFromShift(p0, shifts.q10),
      deltaQ90: deltaFromShift(p0, shifts.q90),
      halfLifeMin: Math.max(0.5, halfLife),
      probYes: fair,
      probMarket: p0,
      confidence: ok.reduce((s, x) => s + x.out.confidence, 0) / ok.length,
      disagreement: pooled.disagreement,
      nAgents: ok.length,
      rationale: ok
        .slice(0, 3)
        .map(x => `${x.agent.name}: ${x.out.rationale}`)
        .join(' | ')
        .slice(0, 3800),
      analogCount: mem.prior.n,
      analogMeanDelta: mem.prior.mean,
    },
    forecasts: ok.map(x => ({
      agentId: x.agent.id,
      probYes: clampProb(x.out.probYes, 0.03),
      expectedDelta: deltaFromShift(p0, x.out.shift),
      halfLifeMin: x.out.halfLifeMin,
      confidence: x.out.confidence,
      rationale: x.out.rationale,
      latencyMs: x.latencyMs,
    })),
  });
  await ctx.conn.reducers.addCalibrationSamples({
    samples: [
      { component: 'consensus:resolution', version: 0, refId: `${signalRef}|${market.conditionId}`, prob: pooled.prob, answer: '', state: '', outcome: undefined },
      { component: 'market:resolution', version: 0, refId: `${signalRef}|${market.conditionId}`, prob: p0, answer: '', state: '', outcome: undefined },
    ],
  });

  // ── escalate to the Pro supervisor, or go straight to decisions
  const mid = ctx.hub.price(market.conditionId)?.mid ?? p0;
  const trust = Math.max(...sessions.map(s => s.risk.modelTrust));
  const blendedEdge = Math.abs(fair - mid) * trust;
  const hrs = hoursToResolution(market);
  const reasons: string[] = [];
  const intel = sessions.map(s => s.intel);
  if (pooled.disagreement > Math.min(...intel.map(i => i.escalateDisagreement))) reasons.push('disagreement');
  if (shifts.agreement < 0.6 && Math.abs(shifts.median) > 0.1) reasons.push('split direction');
  if (blendedEdge > Math.min(...intel.map(i => i.escalateEdge))) reasons.push('edge');
  if (hrs !== undefined && hrs < 72 && Math.abs(expectedDelta) > 0.02) reasons.push('near resolution');
  if ((p.urgency ?? 0) >= 0.66 && Math.abs(expectedDelta) >= 0.03) reasons.push('urgent');
  let escalate = reasons.length >= 2;
  if (reasons.length === 1) {
    const f = await ctx.reflexes
      .fire(
        ['route.escalate'],
        {
          text: `${marketBlock(market)}\n${newsBlock(news)}\nFORECASTERS:\n${ok.map(x => `- ${x.agent.name}: p=${x.out.probYes.toFixed(2)} shift=${x.out.shift} — ${x.out.rationale}`).join('\n')}`,
          features: { disagreement: pooled.disagreement, edge: blendedEdge },
        },
        `${signalRef}`
      )
      .catch(() => undefined);
    escalate = f?.['route.escalate']?.fire ?? false;
  }
  const followups: TaskInput[] = [];
  if (escalate && proBudgetOk(ctx, market.conditionId)) {
    noteProCall(ctx, market.conditionId);
    followups.push(
      task('deliberate', `deliberate:${news.id}:${market.conditionId}`, { signalRef, entityKeys: p.entityKeys ?? [], reasons }, { priority: 80, maxAttempts: 2 })
    );
  } else {
    for (const s of sessions) followups.push(task('decide', `decide:${signalRef}:${s.id}`, { signalRef, sessionId: s.id.toString(), mode: 'signal' }, { sessionId: s.id, priority: 70 }));
  }
  log.info('swarm', {
    market: market.slug || market.conditionId.slice(0, 10),
    agents: ok.length,
    fair: fair.toFixed(3),
    mid: mid.toFixed(3),
    delta: expectedDelta.toFixed(3),
    dis: pooled.disagreement.toFixed(2),
    escalate: escalate ? reasons.join('+') : 'no',
  });
  return {
    result: { signalRef, fair, expectedDelta, disagreement: pooled.disagreement, lessonKeys: mem.lessonKeys, escalate, reasons },
    followups,
    usage: usageSum.get(),
  };
};

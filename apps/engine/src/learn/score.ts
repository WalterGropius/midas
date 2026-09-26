// Scoring: turn outcomes into learning signals. This is where experience
// compounds — every realized reaction becomes
//   • a 'moved' edge in graph memory (the empirical prior for similar news),
//   • fitness for each forecaster (reaction error, direction hit, Brier),
//   • outcomes for System-1 reflex calibration samples,
//   • credit (helpful/harmful) for the lessons that were in context,
//   • and, for big misses, a reflection task that may write a new lesson.
// Only ground truth (realized prices, resolutions) updates anything.
import { brier, ema, estimateHalfLife, hedgeWeights, logLoss, realizedDelta, scoreReaction } from '@midas/core';
import type { Agent, CalibrationSample } from '@midas/stdb-bindings/types';
import type { EngineCtx } from '../ctx';
import { logger } from '../log';
import { keys } from '../memory/graph';
import { task } from '../ledger/types';
import { safeJson } from '../util/async';
import { msFromTs } from '../util/time';
import { byUnique } from '../util/rows';

const log = logger('score');

const HORIZONS = [
  { min: 5, field: 'realizedShort' },
  { min: 30, field: 'realizedMid' },
  { min: 120, field: 'realizedLong' },
] as const;

function sampleByRef(ctx: EngineCtx, component: string, refId: string): CalibrationSample | undefined {
  for (const s of ctx.conn.db.calibrationSample.component.filter(component)) if (s.refId === refId && s.outcome === undefined) return s;
  return undefined;
}

export async function scoreReactions(ctx: EngineCtx) {
  const agentUpdates = new Map<bigint, Agent>();
  const now = Date.now();
  for (const sig of [...ctx.conn.db.signal.iter()]) {
    if (sig.status !== 'open') continue;
    const news = ctx.conn.db.newsItem.id.find(sig.newsId);
    if (!news) continue;
    const newsMs = msFromTs(news.publishedAt);
    const bars = ctx.hub.bars1m(sig.conditionId, newsMs - 10 * 60_000);
    const update: { realizedShort?: number; realizedMid?: number; realizedLong?: number } = {};
    for (const h of HORIZONS) {
      if (sig[h.field] !== undefined) continue;
      const d = realizedDelta(bars, newsMs, h.min, sig.probMarket);
      if (d !== undefined) update[h.field] = d;
    }
    const final = update.realizedLong !== undefined || now - newsMs > 6 * 3_600_000;
    if (Object.keys(update).length === 0 && !final) continue;
    const realized = update.realizedLong ?? sig.realizedLong ?? update.realizedMid ?? sig.realizedMid;
    const sc = realized !== undefined ? scoreReaction({ delta: sig.expectedDelta, q10: sig.deltaQ10, q90: sig.deltaQ90 }, realized) : undefined;
    await ctx.conn.reducers.scoreSignals({
      scores: [
        {
          signalId: sig.id,
          realizedShort: update.realizedShort,
          realizedMid: update.realizedMid,
          realizedLong: update.realizedLong,
          absError: final && sc ? sc.absError : undefined,
          final,
        },
      ],
    });
    if (!final || realized === undefined || !sc) continue;

    // ── agent fitness (reaction error + direction)
    const fScores = [];
    for (const f of ctx.conn.db.agentForecast.signalId.filter(sig.id)) {
      const err = Math.abs(f.expectedDelta - realized);
      fScores.push({ forecastId: f.id, brier: undefined, reactionErr: err });
      const a = agentUpdates.get(f.agentId) ?? ctx.conn.db.agent.id.find(f.agentId);
      if (!a) continue;
      const hit = scoreReaction({ delta: f.expectedDelta, q10: f.expectedDelta, q90: f.expectedDelta }, realized).directionHit;
      agentUpdates.set(a.id, {
        ...a,
        nScored: a.nScored + 1,
        reactionMae: ema(a.reactionMae, err, a.nScored),
        directionHit: ema(a.directionHit, hit, a.nScored),
      });
    }
    if (fScores.length) await ctx.conn.reducers.scoreAgentForecasts({ scores: fScores });

    // ── graph: the realized reaction is now experience
    const lag = estimateHalfLife(bars, newsMs, 120) ?? sig.halfLifeMin;
    await ctx.graph.upsertEdges([
      {
        srcKey: keys.event(sig.newsId),
        dstKey: keys.market(sig.conditionId),
        rel: 'moved',
        key: `${keys.event(sig.newsId)}|moved|${keys.market(sig.conditionId)}`,
        value: realized,
        lagMin: lag,
        weight: 1 + Math.min(3, Math.abs(realized) * 30),
        evidence: `signal:${sig.ref}`,
        status: 'canonical',
      },
    ]);

    // ── System-1 reflex outcomes (ground truth for the coach)
    const refId = `news:${sig.newsId}|${sig.conditionId}`;
    const moved30 = update.realizedMid ?? sig.realizedMid ?? realized;
    const outcomes: { sampleId: bigint; outcome: number }[] = [];
    const rel = sampleByRef(ctx, 'reflex:news.relevance', refId);
    if (rel) outcomes.push({ sampleId: rel.id, outcome: Math.abs(moved30) >= 0.02 ? 1 : 0 });
    const dir = sampleByRef(ctx, 'reflex:news.direction', refId);
    if (dir) outcomes.push({ sampleId: dir.id, outcome: realized > 0.005 ? 1 : 0 });
    const urg = sampleByRef(ctx, 'reflex:news.urgency', refId);
    const moved5 = update.realizedShort ?? sig.realizedShort;
    if (urg && moved5 !== undefined) outcomes.push({ sampleId: urg.id, outcome: Math.abs(moved5) >= 0.02 ? 1 : 0 });
    if (outcomes.length) await ctx.conn.reducers.resolveCalibrationSamples({ outcomes });

    // ── lesson credit (ACE: only ground truth moves the counters)
    const t = byUnique(ctx.conn.db.agentTask.dedupeKey, `swarm:${sig.newsId}:${sig.conditionId}`);
    const lessonKeys = safeJson<{ lessonKeys?: string[] }>(t?.result ?? '{}', {}).lessonKeys ?? [];
    if (lessonKeys.length && sig.layer !== 'reflex') await ctx.graph.creditLessons(lessonKeys, sc.directionHit === 1 && sc.absError < 0.03);

    // ── big misses become reflection tasks
    if (sig.layer !== 'reflex' && sc.absError >= 0.05 && (sc.directionHit === 0 || sc.absError >= 0.1)) {
      await ctx.conn.reducers.enqueueTasks({
        tasks: [task('reflect', `reflect:${sig.ref}`, { signalRef: sig.ref, realized }, { priority: 20, maxAttempts: 2 })],
      });
    }
    log.info('scored', { signal: sig.ref, layer: sig.layer, predicted: sig.expectedDelta.toFixed(3), realized: realized.toFixed(3), hit: sc.directionHit });
  }
  await flushAgentUpdates(ctx, agentUpdates);
}

/** Resolution scoring: Brier/log-loss for every forecast on a resolved market. */
export async function scoreResolutions(ctx: EngineCtx) {
  const agentUpdates = new Map<bigint, Agent>();
  for (const m of ctx.conn.db.market.iter()) {
    if (!m.resolved || m.outcomeYes === undefined) continue;
    const y = m.outcomeYes;
    // calibration samples tied to this market
    const outcomes: { sampleId: bigint; outcome: number }[] = [];
    for (const s of ctx.conn.db.calibrationSample.iter()) {
      if (s.outcome === undefined && s.refId.endsWith(`|${m.conditionId}`) && s.component.endsWith(':resolution')) {
        outcomes.push({ sampleId: s.id, outcome: y });
      }
    }
    if (outcomes.length) await ctx.conn.reducers.resolveCalibrationSamples({ outcomes: outcomes.slice(0, 500) });
    // agent forecasts
    const scores = [];
    for (const f of ctx.conn.db.agentForecast.iter()) {
      if (f.conditionId !== m.conditionId || f.brier !== undefined) continue;
      const b = brier(f.probYes, y);
      scores.push({ forecastId: f.id, brier: b, reactionErr: undefined });
      const a = agentUpdates.get(f.agentId) ?? ctx.conn.db.agent.id.find(f.agentId);
      if (!a) continue;
      agentUpdates.set(a.id, { ...a, brier: ema(a.brier, b, a.nScored), logLoss: ema(a.logLoss, logLoss(f.probYes, y), a.nScored) });
    }
    for (let i = 0; i < scores.length; i += 200) await ctx.conn.reducers.scoreAgentForecasts({ scores: scores.slice(i, i + 200) });
  }
  await flushAgentUpdates(ctx, agentUpdates);
}

/** Persist fitness and re-derive Hedge weights across the active population. */
async function flushAgentUpdates(ctx: EngineCtx, updates: Map<bigint, Agent>) {
  if (updates.size === 0) return;
  const all = [...ctx.conn.db.agent.status.filter('active')].map(a => updates.get(a.id) ?? a);
  // loss per agent: reaction MAE (fast feedback) blended with Brier (slow, resolution)
  const losses = all.map(a => (a.nScored < 5 ? 1 : a.reactionMae * 20 + a.brier * 2) * Math.min(1, a.nScored / 20) + (a.nScored < 20 ? 0.5 : 0));
  const w = hedgeWeights(losses, 1.5);
  const out = all.map((a, i) => ({ ...a, weight: Math.max(0.05, w[i] * all.length) }));
  await ctx.conn.reducers.upsertAgents({
    agents: out.map(a => ({
      id: a.id,
      name: a.name,
      generation: a.generation,
      parentId: a.parentId,
      status: a.status,
      tier: a.tier,
      niche: a.niche,
      persona: a.persona,
      instructions: a.instructions,
      temperature: a.temperature,
      styleTags: a.styleTags,
      weight: a.weight,
      nScored: a.nScored,
      brier: a.brier,
      logLoss: a.logLoss,
      reactionMae: a.reactionMae,
      directionHit: a.directionHit,
      lineageNote: a.lineageNote,
    })),
  });
}

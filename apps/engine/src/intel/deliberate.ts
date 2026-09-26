// L3: the Pro supervisor — called only when the swarm disagrees or the stakes
// are high. It is an independent forecaster that sees the swarm's ARGUMENTS
// (not a vote to average), faces an adversarial critic first, may search the
// web to settle factual cruxes, and must pass a System-1 groundedness check.
// Its number is combined with the swarm's by formula.
import { clampProb, deltaFromShift, logit, sigmoid } from '@midas/core';
import type { EngineCtx } from '../ctx';
import { generateJson } from '../llm/gemini';
import {
  CRITIC_SCHEMA,
  CRITIC_SYSTEM,
  DELIBERATE_SCHEMA,
  DELIBERATE_SYSTEM,
  type CriticOut,
  type DeliberateOut,
} from '../llm/prompts';
import { logger } from '../log';
import { keys } from '../memory/graph';
import { task, UsageSum, type Handler, type TaskInput } from '../ledger/types';
import { msFromTs, ref } from '../util/time';
import { newsBlock, operatorNotes, sessionsForMarket } from './common';
import { priceAtNews, sharedPrefix } from './swarm';
import { byUnique } from '../util/rows';

const log = logger('deliberate');

/** Weight of the Pro supervisor vs the pooled swarm in log-odds. */
const PRO_WEIGHT = Number(process.env.MIDAS_PRO_WEIGHT ?? 0.6);

export const deliberate: Handler = async (ctx, _task, p: { signalRef: string; entityKeys: string[]; reasons: string[] }) => {
  const swarmSignal = byUnique(ctx.conn.db.signal.ref, p.signalRef);
  if (!swarmSignal) return { result: { skipped: 'signal missing' } };
  const news = ctx.conn.db.newsItem.id.find(swarmSignal.newsId);
  const market = ctx.hub.market(swarmSignal.conditionId);
  if (!news || !market || !market.active) return { result: { skipped: 'news/market unavailable' } };

  const eventKey = keys.event(news.id);
  const eventNode = ctx.graph.node(eventKey);
  const mem = ctx.graph.context({
    entityKeys: p.entityKeys,
    marketKey: keys.market(market.conditionId),
    embedding: eventNode && eventNode.embedding.length > 0 ? eventNode.embedding : undefined,
    excludeKeys: [eventKey],
    k: 20,
  });
  const prefix = sharedPrefix(market, news, mem, operatorNotes(ctx, market.conditionId));
  const forecasts = [...ctx.conn.db.agentForecast.signalId.filter(swarmSignal.id)];
  const argumentsRaised = forecasts
    .map(f => `- (${ctx.conn.db.agent.id.find(f.agentId)?.persona ?? 'forecaster'}) ${f.rationale}`)
    .join('\n');
  const usage = new UsageSum();
  const sessions = sessionsForMarket(ctx, market.conditionId);

  // 1. adversarial critic (cheap, Flash): "find how this breaks"
  let critic: CriticOut = { flaws: [], probAdjustment: 0, severity: 0 };
  try {
    const r = await generateJson<CriticOut>({
      route: 'critic',
      tier: 'flash',
      system: CRITIC_SYSTEM,
      prefix,
      suffix: `PROPOSAL: the fast forecasters lean ${swarmSignal.expectedDelta >= 0 ? 'toward YES' : 'toward NO'} on this news (expected move ${(swarmSignal.expectedDelta * 100).toFixed(1)} points).\nTHEIR ARGUMENTS:\n${argumentsRaised}`,
      schema: CRITIC_SCHEMA,
      thinking: 'medium',
      sessionId: sessions[0]?.id,
    });
    usage.add(r);
    critic = r.data;
  } catch (err) {
    log.warn('critic failed', { err: String(err) });
  }

  // 2. Pro supervisor with search grounding
  const r = await generateJson<DeliberateOut>({
    route: 'deliberate',
    tier: 'pro',
    system: DELIBERATE_SYSTEM,
    prefix,
    suffix: `WHY YOU WERE CALLED: ${p.reasons.join(', ')}\n\nARGUMENTS RAISED BY THE FAST FORECASTERS:\n${argumentsRaised}\n\nREVIEWER OBJECTIONS (severity ${critic.severity.toFixed(2)}):\n${critic.flaws.map(f => `- ${f}`).join('\n') || '- none'}`,
    schema: DELIBERATE_SCHEMA,
    thinking: 'high',
    search: { query: news.title },
    sessionId: sessions[0]?.id,
    maxOutputTokens: 8192,
  });
  usage.add(r);
  const pro = r.data;

  // 3. groundedness reflex: are the rationale's claims in the evidence?
  const grounded = await ctx.reflexes
    .fire(
      ['claim.grounded'],
      {
        text: `RATIONALE: ${pro.rationale}\n\nEVIDENCE:\n${newsBlock(news)}\n${mem.text}`,
        payload: { rationale: pro.rationale, evidence: `${newsBlock(news)}\n${mem.text}`.slice(0, 8000) },
      },
      `pro:${p.signalRef}`
    )
    .catch(() => undefined);
  const isGrounded = grounded?.['claim.grounded']?.fire ?? true;

  // 4. combine by formula
  const p0 = priceAtNews(ctx, market.conditionId, msFromTs(news.publishedAt));
  const proProb = clampProb(pro.probYes, 0.03);
  const fair = clampProb(sigmoid(PRO_WEIGHT * logit(proProb) + (1 - PRO_WEIGHT) * logit(swarmSignal.probYes)), 0.03);
  const swarmShift = logit(clampProb(p0 + swarmSignal.expectedDelta)) - logit(p0);
  const shift = PRO_WEIGHT * pro.shift + (1 - PRO_WEIGHT) * swarmShift;
  let confidence = pro.confidence * (1 - Math.min(0.9, critic.severity)) * (isGrounded ? 1 : 0.3);
  if (!pro.tradeable) confidence = 0;

  const signalRef = ref('sig');
  const proAgent = [...ctx.conn.db.agent.iter()].find(a => a.tier === 'pro' && a.status === 'active');
  await ctx.conn.reducers.insertSignal({
    signal: {
      ref: signalRef,
      newsId: news.id,
      conditionId: market.conditionId,
      layer: 'pro',
      expectedDelta: deltaFromShift(p0, shift),
      deltaQ10: deltaFromShift(p0, PRO_WEIGHT * pro.shiftLow + (1 - PRO_WEIGHT) * swarmShift * 0.5),
      deltaQ90: deltaFromShift(p0, PRO_WEIGHT * pro.shiftHigh + (1 - PRO_WEIGHT) * swarmShift * 1.5),
      halfLifeMin: Math.max(0.5, pro.halfLifeMin),
      probYes: fair,
      probMarket: p0,
      confidence,
      disagreement: swarmSignal.disagreement,
      nAgents: swarmSignal.nAgents + 1,
      rationale: `${pro.tradeable ? '' : '[not tradeable] '}${isGrounded ? '' : '[ungrounded] '}${pro.rationale} ${pro.citations?.length ? `(cites ${pro.citations.join(', ')})` : ''}`.slice(0, 3900),
      analogCount: mem.prior.n,
      analogMeanDelta: mem.prior.mean,
    },
    forecasts: proAgent
      ? [
          {
            agentId: proAgent.id,
            probYes: proProb,
            expectedDelta: deltaFromShift(p0, pro.shift),
            halfLifeMin: pro.halfLifeMin,
            confidence: pro.confidence,
            rationale: pro.rationale,
            latencyMs: r.latencyMs,
          },
        ]
      : [],
  });
  await ctx.conn.reducers.addCalibrationSamples({
    samples: [
      { component: 'pro:resolution', version: 0, refId: `${signalRef}|${market.conditionId}`, prob: proProb, answer: '', state: '', outcome: undefined },
      {
        component: 'final:resolution',
        version: 0,
        refId: `${signalRef}|${market.conditionId}`,
        prob: fair,
        answer: '',
        state: '',
        outcome: undefined,
      },
    ],
  });
  const followups: TaskInput[] = sessions.map(s =>
    task('decide', `decide:${signalRef}:${s.id}`, { signalRef, sessionId: s.id.toString(), mode: 'signal' }, { sessionId: s.id, priority: 90 })
  );
  log.info('pro verdict', {
    market: market.slug || market.conditionId.slice(0, 10),
    pro: proProb.toFixed(3),
    swarm: swarmSignal.probYes.toFixed(3),
    fair: fair.toFixed(3),
    tradeable: pro.tradeable,
    grounded: isGrounded,
    critic: critic.severity.toFixed(2),
  });
  return {
    result: { signalRef, fair, tradeable: pro.tradeable, grounded: isGrounded, criticSeverity: critic.severity, citations: pro.citations, lessonKeys: mem.lessonKeys },
    followups,
    usage: usage.get(),
  };
};

// Self-evolution on two slow timescales, both run as ratchets:
//
//   evolveAgents — GEPA-style: pick a parent from the Pareto front of
//     per-case reaction losses, let Gemini Pro rewrite its STYLE from its worst
//     and best cases (reflective mutation), replay parent and child on held-out
//     cases with point-in-time memory, keep the child only if a paired
//     bootstrap says it is better. The held-out split is time-based and never
//     shown to the mutator.
//
//   coachReflexes — the skateboarder loop: System 1 reacts in milliseconds;
//     System 2 (Pro) studies its misfires and rewrites the reflex's question.
//     The rewrite is replayed on stored state snapshots through the same
//     decision model and kept only if Brier improves; the firing threshold is
//     retuned numerically for utility.
import {
  applyPlatt,
  brier,
  chooseRetirements,
  clampProb,
  deltaFromShift,
  mulberry32,
  ratchetAccept,
  reflexProb,
  sampleParent,
  tuneThreshold,
  type Candidate,
  type Utility,
} from '@midas/core';
import type { Agent, CalibrationSample, Signal } from '@midas/stdb-bindings/types';
import { config } from '../config';
import type { EngineCtx } from '../ctx';
import { geminiAvailable, generateJson } from '../llm/gemini';
import {
  COACH_SCHEMA,
  COACH_SYSTEM,
  FORECAST_SCHEMA,
  FORECASTER_SYSTEM,
  MUTATE_SCHEMA,
  MUTATE_SYSTEM,
  type CoachOut,
  type ForecastOut,
  type MutateOut,
} from '../llm/prompts';
import { logger } from '../log';
import { keys } from '../memory/graph';
import { operatorNotes } from '../intel/common';
import { agentSuffix, sharedPrefix } from '../intel/swarm';
import { decide as s1decide } from '../s1/systemone';
import { rowToDef } from '../s1/reflexes';
import { limiter } from '../util/async';
import { msFromTs } from '../util/time';
import { UsageSum, type Handler } from '../ledger/types';

const log = logger('evolve');

interface Case {
  signal: Signal;
  realized: number;
}

function reactionCases(ctx: EngineCtx, n = 60): Case[] {
  return [...ctx.conn.db.signal.iter()]
    .filter(s => s.layer === 'swarm' && s.status === 'scored' && s.realizedLong !== undefined)
    .sort((a, b) => Number(a.createdAt.microsSinceUnixEpoch - b.createdAt.microsSinceUnixEpoch))
    .slice(-n)
    .map(s => ({ signal: s, realized: s.realizedLong! }));
}

function lossFor(ctx: EngineCtx, agentId: bigint, c: Case): number | undefined {
  for (const f of ctx.conn.db.agentForecast.signalId.filter(c.signal.id)) {
    if (f.agentId === agentId) return Math.abs(f.expectedDelta - c.realized);
  }
  return undefined;
}

/** Re-run one forecaster on a past case, with memory as it was at the time. */
async function replay(ctx: EngineCtx, persona: string, instructions: string, c: Case, usage: UsageSum): Promise<number | undefined> {
  const news = ctx.conn.db.newsItem.id.find(c.signal.newsId);
  const market = ctx.hub.market(c.signal.conditionId);
  if (!news || !market) return undefined;
  const newsMs = msFromTs(news.publishedAt);
  const eventKey = keys.event(news.id);
  const ev = ctx.graph.node(eventKey);
  const mem = ctx.graph.context({
    entityKeys: news.entities.map(e => keys.entity(e)),
    marketKey: keys.market(market.conditionId),
    embedding: ev && ev.embedding.length ? ev.embedding : undefined,
    asOfMs: newsMs,
    excludeKeys: [eventKey],
  });
  const r = await generateJson<ForecastOut>({
    route: 'evolve-replay',
    tier: 'flash',
    system: FORECASTER_SYSTEM,
    prefix: sharedPrefix(market, news, mem, operatorNotes(ctx, market.conditionId)),
    suffix: agentSuffix({ persona, instructions }),
    schema: FORECAST_SCHEMA,
    thinking: 'low',
  });
  usage.add(r);
  return Math.abs(deltaFromShift(c.signal.probMarket, r.data.shift) - c.realized);
}

function describeCase(ctx: EngineCtx, c: Case, agentId: bigint): string {
  const news = ctx.conn.db.newsItem.id.find(c.signal.newsId);
  const market = ctx.hub.market(c.signal.conditionId);
  const f = [...ctx.conn.db.agentForecast.signalId.filter(c.signal.id)].find(x => x.agentId === agentId);
  return `- NEWS: ${news?.title ?? '?'}\n  MARKET: ${market?.question ?? '?'}\n  YOU PREDICTED: ${f ? (100 * f.expectedDelta).toFixed(1) : '?'} pts; ACTUAL: ${(100 * c.realized).toFixed(1)} pts\n  YOUR REASONING: ${f?.rationale ?? ''}`;
}

export const evolveAgents: Handler = async ctx => {
  if (!geminiAvailable()) return { result: { skipped: 'no model' } };
  const cases = reactionCases(ctx);
  if (cases.length < 30) return { result: { skipped: `need ≥30 scored cases, have ${cases.length}` } };
  const split = Math.floor(cases.length * 0.66);
  const train = cases.slice(0, split);
  const heldOut = cases.slice(split).slice(-20);
  const agents = [...ctx.conn.db.agent.status.filter('active')].filter(a => a.tier === 'flash');
  const rng = mulberry32(Date.now() & 0xffffffff);

  const cands: Candidate[] = agents.map(a => ({
    id: a.id.toString(),
    caseLosses: train.map(c => lossFor(ctx, a.id, c) ?? Number.NaN).map(x => (Number.isFinite(x) ? x : 1)),
  }));
  const parentId = sampleParent(rng, cands);
  const parent = agents.find(a => a.id.toString() === parentId);
  if (!parent) return { result: { skipped: 'no parent on the Pareto front' } };

  const scored = train
    .map(c => ({ c, loss: lossFor(ctx, parent.id, c) }))
    .filter((x): x is { c: Case; loss: number } => x.loss !== undefined)
    .sort((a, b) => b.loss - a.loss);
  if (scored.length < 8) return { result: { skipped: 'parent has too few scored cases' } };
  const usage = new UsageSum();
  const mut = await generateJson<MutateOut>({
    route: 'mutate',
    tier: 'pro',
    system: MUTATE_SYSTEM,
    prefix: `CURRENT STYLE — ${parent.persona}:\n${parent.instructions}\n\nTRACK RECORD: reaction MAE ${(100 * parent.reactionMae).toFixed(2)} pts, direction hit ${(100 * parent.directionHit).toFixed(0)}%, Brier ${parent.brier.toFixed(3)}, n=${parent.nScored}.`,
    suffix: `WORST CASES:\n${scored.slice(0, 5).map(x => describeCase(ctx, x.c, parent.id)).join('\n')}\n\nBEST CASES:\n${scored.slice(-3).map(x => describeCase(ctx, x.c, parent.id)).join('\n')}`,
    schema: MUTATE_SCHEMA,
    thinking: 'medium',
  });
  usage.add(mut);

  // paired replay on held-out cases (both genomes see identical inputs)
  const gate = limiter(4);
  const pairs = await Promise.all(
    heldOut.map(c =>
      gate(async () => {
        try {
          const [pl, cl] = await Promise.all([
            replay(ctx, parent.persona, parent.instructions, c, usage),
            replay(ctx, mut.data.persona, mut.data.instructions, c, usage),
          ]);
          return pl !== undefined && cl !== undefined ? { pl, cl } : undefined;
        } catch {
          return undefined;
        }
      })
    )
  );
  const ok = pairs.filter((x): x is { pl: number; cl: number } => Boolean(x));
  const verdict = ratchetAccept(
    ok.map(x => x.pl),
    ok.map(x => x.cl),
    rng,
    { minImprovement: 0.002, confidence: 0.9, minN: 12 }
  );
  const baseline = ok.reduce((s, x) => s + x.pl, 0) / Math.max(1, ok.length);
  const candidate = ok.reduce((s, x) => s + x.cl, 0) / Math.max(1, ok.length);

  let childId = 0n;
  if (verdict.keep) {
    await ctx.conn.reducers.upsertAgents({
      agents: [
        {
          id: 0n,
          name: `${parent.name.split('~')[0]}~g${parent.generation + 1}`,
          generation: parent.generation + 1,
          parentId: parent.id,
          status: 'active',
          tier: parent.tier,
          niche: parent.niche,
          persona: mut.data.persona.slice(0, 120),
          instructions: mut.data.instructions,
          temperature: parent.temperature,
          styleTags: parent.styleTags,
          weight: parent.weight,
          nScored: 0,
          brier: parent.brier,
          logLoss: parent.logLoss,
          reactionMae: candidate,
          directionHit: parent.directionHit,
          lineageNote: mut.data.rationale.slice(0, 1500),
        },
      ],
    });
    childId = [...ctx.conn.db.agent.iter()].filter(a => a.parentId === parent.id).sort((a, b) => Number(b.id - a.id))[0]?.id ?? 0n;
    // make room: retire the weakest, never the last of a niche
    const active = [...ctx.conn.db.agent.status.filter('active')].filter(a => a.tier === 'flash');
    const retire = chooseRetirements(
      active.map(a => ({ id: a.id.toString(), niche: a.niche, score: a.reactionMae, nScored: a.nScored })),
      config.intel.maxActiveAgents
    );
    for (const id of retire) {
      const a = ctx.conn.db.agent.id.find(BigInt(id));
      if (a) await retireAgent(ctx, a);
    }
  }
  await ctx.conn.reducers.recordTrial({
    trial: {
      subject: `agent:${parent.id}`,
      agentId: childId,
      parentId: parent.id,
      generation: parent.generation + 1,
      baselineScore: baseline,
      candidateScore: candidate,
      nEval: ok.length,
      decision: verdict.keep ? 'kept' : 'reverted',
      mutation: `${mut.data.persona}: ${mut.data.instructions}\n\nwhy: ${mut.data.rationale}\n\nverdict: ${verdict.reason} (p=${verdict.pBetter.toFixed(2)})`,
      metric: 'reaction MAE',
    },
  });
  if (verdict.keep) await ctx.alerts.send('evolution', `Evolution kept a new forecaster from ${parent.name}: MAE ${(100 * baseline).toFixed(2)} → ${(100 * candidate).toFixed(2)} pts`);
  log.info('evolution trial', { parent: parent.name, keep: verdict.keep, baseline: baseline.toFixed(4), candidate: candidate.toFixed(4), n: ok.length });
  return { result: { parent: parent.name, verdict }, usage: usage.get() };
};

async function retireAgent(ctx: EngineCtx, a: Agent) {
  await ctx.conn.reducers.upsertAgents({
    agents: [
      {
        id: a.id,
        name: a.name,
        generation: a.generation,
        parentId: a.parentId,
        status: 'retired',
        tier: a.tier,
        niche: a.niche,
        persona: a.persona,
        instructions: a.instructions,
        temperature: a.temperature,
        styleTags: a.styleTags,
        weight: 0,
        nScored: a.nScored,
        brier: a.brier,
        logLoss: a.logLoss,
        reactionMae: a.reactionMae,
        directionHit: a.directionHit,
        lineageNote: `${a.lineageNote}\nretired by selection`,
      },
    ],
  });
}

// ─────────────────────────────── reflex coach ───────────────────────────────

const UTILITY: Record<string, Utility> = {
  // missing a market-moving headline costs more than an extra swarm call
  'news.relevance': { tp: 1, fp: -0.15, fn: -1, tn: 0 },
  'news.direction': { tp: 1, fp: -1, fn: -0.3, tn: 0 },
  'news.urgency': { tp: 1, fp: -0.5, fn: -0.5, tn: 0 },
  'position.exit': { tp: 1, fp: -0.5, fn: -1, tn: 0 },
};

function parseState(snapshot: string): string | Record<string, unknown> {
  try {
    const v = JSON.parse(snapshot);
    return typeof v === 'object' && v ? v : snapshot;
  } catch {
    return snapshot;
  }
}

export const coachReflexes: Handler = async ctx => {
  const usage = new UsageSum();
  const report: Record<string, unknown> = {};
  // pick the reflex with the most room to improve
  const ranked = [...ctx.conn.db.reflex.iter()]
    .filter(r => r.enabled && r.nResolved >= 40)
    .sort((a, b) => b.brier - a.brier);
  const r = ranked[0];
  if (!r) return { result: { skipped: 'no reflex with ≥40 resolved samples' } };
  const def = rowToDef(r);
  const samples = [...ctx.conn.db.calibrationSample.component.filter(`reflex:${r.key}`)]
    .filter((s): s is CalibrationSample & { outcome: number } => s.outcome !== undefined && s.version === r.version && s.state.length > 0)
    .sort((a, b) => Number(a.createdAt.microsSinceUnixEpoch - b.createdAt.microsSinceUnixEpoch));
  if (samples.length < 40) return { result: { skipped: `${r.key}: ${samples.length} usable samples` } };

  // 1. numeric half: retune the firing threshold on calibrated probabilities
  const cal = ctx.conn.db.calibrator.component.find(`reflex:${r.key}`);
  const calibrated = samples.map(s => ({ p: applyPlatt(s.prob, cal && cal.n >= 30 ? cal : undefined), y: s.outcome }));
  const util = UTILITY[r.key] ?? { tp: 1, fp: -1, fn: -1, tn: 0 };
  const tuned = tuneThreshold(calibrated, util);
  const current = tuneThreshold(calibrated.map(x => ({ ...x })), util, 1); // utility at 0.5 as a reference
  report.threshold = { from: r.threshold, to: tuned.threshold, utility: tuned.utility, atHalf: current.baseline };

  // 2. linguistic half: Pro rewrites the question from misfires
  let candidate: CoachOut | undefined;
  if (geminiAvailable()) {
    const fp = samples.filter(s => s.prob >= r.threshold && s.outcome < 0.5).slice(-6);
    const fn = samples.filter(s => s.prob < r.threshold && s.outcome >= 0.5).slice(-6);
    const res = await generateJson<CoachOut>({
      route: 'coach',
      tier: 'pro',
      system: COACH_SYSTEM,
      prefix: `REFLEX ${r.key} (type ${r.qtype}, version ${r.version}, threshold ${r.threshold})\nQUESTION: ${r.instructions}\n${r.criteriaKeys.length ? `OPTIONS:\n${r.criteriaKeys.map((k, i) => `- ${k}: ${r.criteriaText[i]}`).join('\n')}` : ''}\nRECORD: Brier ${r.brier.toFixed(3)}, hit rate ${(100 * r.hitRate).toFixed(0)}%, n=${r.nResolved}`,
      suffix: `FIRED BUT WRONG (false positives):\n${fp.map(s => `- p=${s.prob.toFixed(2)} :: ${s.state.slice(0, 500)}`).join('\n') || '- none'}\n\nDID NOT FIRE BUT SHOULD HAVE (false negatives):\n${fn.map(s => `- p=${s.prob.toFixed(2)} :: ${s.state.slice(0, 500)}`).join('\n') || '- none'}`,
      schema: COACH_SCHEMA,
      thinking: 'medium',
    });
    usage.add(res);
    candidate = res.data;
  }

  let decision = 'threshold-only';
  let baselineScore = 0;
  let candidateScore = 0;
  let nEval = 0;
  let version = r.version;
  let instructions = r.instructions;
  let criteriaText = r.criteriaText;
  if (candidate && candidate.instructions.trim()) {
    const heldOut = samples.slice(-24);
    const candText = candidate.criteriaText.length === r.criteriaText.length ? candidate.criteriaText : r.criteriaText;
    const gate = limiter(8);
    const pairs = await Promise.all(
      heldOut.map(s =>
        gate(async () => {
          try {
            const state = parseState(s.state);
            const { answers } = await s1decide({
              state,
              questions: {
                current: { def },
                candidate: { def, instructions: candidate!.instructions, criteriaText: candText },
              },
            });
            return {
              base: brier(clampProb(reflexProb(def, answers.current), 1e-4), s.outcome),
              cand: brier(clampProb(reflexProb(def, answers.candidate), 1e-4), s.outcome),
            };
          } catch {
            return undefined;
          }
        })
      )
    );
    const ok = pairs.filter((x): x is { base: number; cand: number } => Boolean(x));
    const verdict = ratchetAccept(
      ok.map(x => x.base),
      ok.map(x => x.cand),
      mulberry32(Date.now() & 0xffffffff),
      { minImprovement: 0.002, confidence: 0.85, minN: 12 }
    );
    nEval = ok.length;
    baselineScore = ok.reduce((a, x) => a + x.base, 0) / Math.max(1, ok.length);
    candidateScore = ok.reduce((a, x) => a + x.cand, 0) / Math.max(1, ok.length);
    decision = verdict.keep ? 'kept' : 'reverted';
    if (verdict.keep) {
      version = r.version + 1;
      instructions = candidate.instructions;
      criteriaText = candText;
    }
    report.rewrite = { verdict, baselineScore, candidateScore };
  }
  const thresholdImproved = tuned.utility > current.baseline * 1.05 + 1e-9 && Math.abs(tuned.threshold - r.threshold) >= 0.05;
  if (decision === 'kept' || thresholdImproved) {
    await ctx.conn.reducers.upsertReflexes({
      reflexes: [
        {
          key: r.key,
          qtype: r.qtype,
          instructions,
          criteriaKeys: r.criteriaKeys,
          criteriaText,
          // a rewritten question starts from its own calibration; keep the threshold then
          threshold: decision === 'kept' ? r.threshold : tuned.threshold,
          provider: r.provider,
          version,
          candidateInstructions: '',
          candidateThreshold: 0,
          enabled: r.enabled,
          coachNote: `${decision === 'kept' ? `rewrite kept (Brier ${baselineScore.toFixed(3)} → ${candidateScore.toFixed(3)}): ${candidate?.rationale ?? ''}` : `threshold ${r.threshold.toFixed(2)} → ${tuned.threshold.toFixed(2)}`}`.slice(0, 1900),
        },
      ],
    });
  }
  await ctx.conn.reducers.recordTrial({
    trial: {
      subject: `reflex:${r.key}`,
      agentId: 0n,
      parentId: 0n,
      generation: version,
      baselineScore,
      candidateScore,
      nEval,
      decision: decision === 'threshold-only' ? (thresholdImproved ? 'kept' : 'reverted') : decision,
      mutation: candidate ? `${candidate.instructions}\n\nwhy: ${candidate.rationale}` : `threshold → ${tuned.threshold.toFixed(2)}`,
      metric: 'Brier (replayed)',
    },
  });
  log.info('coached reflex', { key: r.key, decision, threshold: `${r.threshold}→${tuned.threshold}` });
  return { result: { key: r.key, decision, ...report }, usage: usage.get() };
};

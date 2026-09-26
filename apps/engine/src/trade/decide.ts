// The decision + evaluation plane. Deterministic: no model calls, every rule
// written down, every verdict (approved or rejected, with reasons) recorded.
//
// Two strategies read the same signal:
//   reaction — trade the predicted move caused by the news, exit on target,
//              stop or time; skip if ≥50% of the move already happened
//              (RSS is late; the market may already know).
//   value    — trade the gap between the market-blended fair value and the
//              price, only for mid-range prices and ≥3 days to resolution,
//              post-only (maker, fee-free) and held toward resolution.
import {
  blendWithMarket,

  clampProb,
  independentConfirmation,
  maxStakeUsd,
  preTradeReasons,
  sizePosition,
  type AccountState,
  type BookLevel,
  type RiskLimits,
} from '@midas/core';
import type { Market, Session, Signal } from '@midas/stdb-bindings/types';
import { config } from '../config';
import type { EngineCtx } from '../ctx';
import { hoursToResolution } from '../intel/common';
import { logger } from '../log';
import { haltAll } from '../stdb';
import { msFromTs, ref } from '../util/time';
import type { Handler } from '../ledger/types';
import { execute, liveBlock, openPosition, takerFee, type ExitPlan } from './executor';
import { byUnique } from '../util/rows';
import { keyedMutex } from '../util/async';

const log = logger('decide');

interface Candidate {
  strategy: 'reaction' | 'value';
  outcome: 'YES' | 'NO';
  /** probability (outcome space) used for sizing */
  p: number;
  /** current market mid (YES space) */
  mid: number;
  edge: number;
  postOnly: boolean;
  plan: ExitPlan;
  reasons: string[];
}

export function accountFor(ctx: EngineCtx, s: Session, conditionId: string): AccountState {
  let exposure = 0;
  let inMarket = 0;
  let open = 0;
  for (const p of ctx.conn.db.position.sessionId.filter(s.id)) {
    if (p.closed) continue;
    open++;
    const v = p.shares * p.markPrice;
    exposure += v;
    if (p.conditionId === conditionId) inMarket += v;
  }
  return {
    equityUsd: s.equityUsd,
    cashUsd: s.cashUsd,
    peakEquityUsd: s.peakEquityUsd,
    dayStartEquityUsd: s.dayStartEquityUsd,
    exposureUsd: exposure,
    openPositions: open,
    exposureInMarketUsd: inMarket,
  };
}

/** Independent lines of evidence that agree with the proposed direction. */
function confirmations(ctx: EngineCtx, signal: Signal, dir: number, mid: number): { n: number; conf: number; which: string[] } {
  const which: string[] = [];
  const conf: number[] = [];
  const add = (name: string, c: number) => {
    which.push(name);
    conf.push(c);
  };
  if (signal.layer === 'pro' && signal.confidence > 0.3) add('pro supervisor', 0.6);
  if (signal.layer !== 'reflex' && signal.disagreement < 0.5) add('swarm agreement', 0.5);
  if (signal.analogCount >= 2 && Math.sign(signal.analogMeanDelta) === dir) add('historical analogs', 0.5);
  // System-1 direction reflex from triage (refId news:<id>|<cid>)
  const refId = `news:${signal.newsId}|${signal.conditionId}`;
  for (const s of ctx.conn.db.calibrationSample.component.filter('reflex:news.direction')) {
    if (s.refId !== refId) continue;
    if ((dir > 0 && s.answer === 'up') || (dir < 0 && s.answer === 'down')) add('System-1 direction', 0.45);
    break;
  }
  // market already moving our way since the signal
  if (Math.sign(mid - signal.probMarket) === dir && Math.abs(mid - signal.probMarket) > 0.005) add('price momentum', 0.35);
  // TimesFM path drifting our way
  const path = [...ctx.conn.db.pathForecast.conditionId.filter(signal.conditionId)].sort((a, b) =>
    Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch)
  )[0];
  if (path && path.point.length > 0 && Math.sign(path.point[path.point.length - 1] - path.lastPrice) === dir) add('path forecast', 0.3);
  return { n: which.length, conf: independentConfirmation(conf), which };
}

function candidates(ctx: EngineCtx, s: Session, m: Market, signal: Signal, mode: string, mid: number, spread: number): Candidate[] {
  const out: Candidate[] = [];
  const r = s.risk;
  const newsMs = (() => {
    const n = ctx.conn.db.newsItem.id.find(signal.newsId);
    return n ? msFromTs(n.publishedAt) : msFromTs(signal.createdAt);
  })();

  // ── reaction
  if (r.strategy !== 'value' && Math.abs(signal.expectedDelta) >= 0.015) {
    const reasons: string[] = [];
    const moved = mid - signal.probMarket;
    const remaining = signal.expectedDelta - moved;
    const dir = Math.sign(signal.expectedDelta);
    if (Math.sign(remaining) !== dir || Math.abs(remaining) < 0.5 * Math.abs(signal.expectedDelta)) {
      reasons.push(`already priced: ${(100 * moved).toFixed(1)} of ${(100 * signal.expectedDelta).toFixed(1)} pts moved`);
    }
    const elapsedMin = (Date.now() - newsMs) / 60_000;
    if (elapsedMin > 4 * signal.halfLifeMin + 30) reasons.push(`stale: ${elapsedMin.toFixed(0)} min after news`);
    const target = clampProb(signal.probMarket + signal.expectedDelta, 0.01);
    const outcome: 'YES' | 'NO' = dir > 0 ? 'YES' : 'NO';
    const pOut = outcome === 'YES' ? target : 1 - target;
    const entry = outcome === 'YES' ? mid + spread / 2 : 1 - mid + spread / 2;
    out.push({
      strategy: 'reaction',
      outcome,
      p: pOut,
      mid,
      edge: pOut - entry,
      postOnly: false,
      plan: {
        strategy: 'reaction',
        targetPrice: clampProb(entry + 0.8 * (pOut - entry), 0.01),
        stopPrice: Math.max(0.01, entry - 0.8 * Math.abs(signal.expectedDelta)),
        timeStopMs: Date.now() + Math.max(10, 3 * signal.halfLifeMin) * 60_000,
      },
      reasons,
    });
  }

  // ── value (never on a bare reflex)
  if (r.strategy !== 'reaction' && mode !== 'reflex' && signal.confidence > 0) {
    const reasons: string[] = [];
    const fair = blendWithMarket(signal.probYes, mid, r.modelTrust);
    const outcome: 'YES' | 'NO' = fair > mid ? 'YES' : 'NO';
    const pOut = outcome === 'YES' ? fair : 1 - fair;
    const price = outcome === 'YES' ? mid : 1 - mid;
    if (mid < 0.15 || mid > 0.85) reasons.push(`price ${mid.toFixed(2)} outside 0.15–0.85`);
    if (price < 0.1) reasons.push('longshot under 10¢');
    const hrs = hoursToResolution(m);
    if (hrs !== undefined && hrs < 72) reasons.push(`resolves in ${hrs.toFixed(0)}h (<72h)`);
    // ensemble spread in probability space
    const spreadProb = signal.disagreement * mid * (1 - mid);
    const hurdle = r.minEdge + spread / 2 + takerFee(m, 1, price) + 1.5 * spreadProb;
    const gap = Math.abs(fair - mid);
    if (gap < hurdle) reasons.push(`gap ${(100 * gap).toFixed(1)} < hurdle ${(100 * hurdle).toFixed(1)} pts`);
    out.push({
      strategy: 'value',
      outcome,
      p: pOut,
      mid,
      edge: gap,
      postOnly: spread >= 2 * (m.tickSize || 0.01),
      plan: { strategy: 'value', targetPrice: clampProb(pOut, 0.01), stopPrice: 0, timeStopMs: 0 },
      reasons,
    });
  }
  return out;
}

// Sizing reads the session's cash and exposure, so decisions for one session
// run one at a time: each sees the fills booked by the one before it.
const sessionLock = keyedMutex();

type DecidePayload = { signalRef: string; sessionId: string; mode: 'reflex' | 'signal' };

export const decide: Handler = (ctx, task, p: DecidePayload) => sessionLock(p.sessionId, () => decideLocked(ctx, task, p));

const decideLocked: Handler = async (ctx, _task, p: DecidePayload) => {
  const signal = byUnique(ctx.conn.db.signal.ref, p.signalRef);
  const s = ctx.conn.db.session.id.find(BigInt(p.sessionId));
  if (!signal || !s) return { result: { skipped: 'signal or session missing' } };
  const m = ctx.hub.market(signal.conditionId);
  if (!m) return { result: { skipped: 'market missing' } };
  const decisionRef = ref('dec');
  const risk = s.risk as RiskLimits;

  const record = async (verdict: 'approved' | 'rejected', c: Candidate | undefined, extra: Partial<{ sizeUsd: number; kelly: number; confirmations: number; confidence: number }>, reasons: string[]) => {
    await ctx.conn.reducers.recordDecision({
      decision: {
        ref: decisionRef,
        sessionId: s.id,
        conditionId: m.conditionId,
        signalRef: p.signalRef,
        action: c ? `BUY_${c.outcome}` : 'HOLD',
        strategy: c?.strategy ?? (p.mode === 'reflex' ? 'reaction' : 'n/a'),
        fairProb: c ? (c.outcome === 'YES' ? c.p : 1 - c.p) : signal.probYes,
        marketPrice: c?.mid ?? ctx.hub.price(m.conditionId)?.mid ?? 0,
        edge: c?.edge ?? 0,
        kellyFraction: extra.kelly ?? 0,
        sizeUsd: extra.sizeUsd ?? 0,
        confirmations: extra.confirmations ?? 0,
        confidence: extra.confidence ?? 0,
        verdict,
        reasons: reasons.slice(0, 20),
      },
    });
  };

  // fresh books: memory is a hint, the venue is the truth
  const [yes, no] = await Promise.all([ctx.hub.freshBook(m.conditionId, 'YES'), ctx.hub.freshBook(m.conditionId, 'NO')]);
  if (!yes || !no) {
    await record('rejected', undefined, {}, ['could not fetch order book']);
    return { result: { verdict: 'rejected', reason: 'no book' } };
  }
  const bestBid = yes.bids[0]?.price ?? 0;
  const bestAsk = yes.asks[0]?.price ?? 1;
  const mid = (bestBid + bestAsk) / 2;
  const spread = Math.max(0, bestAsk - bestBid);
  ctx.hub.observe(m.conditionId, { mid, bid: bestBid, ask: bestAsk, tsMs: Date.now() });

  const acct = accountFor(ctx, s, m.conditionId);
  const cands = candidates(ctx, s, m, signal, p.mode, mid, spread);
  if (cands.length === 0) {
    await record('rejected', undefined, {}, ['no strategy applies (move too small / strategy filter)']);
    return { result: { verdict: 'rejected' } };
  }
  // best candidate: fewest blockers, then largest edge
  cands.sort((a, b) => a.reasons.length - b.reasons.length || b.edge - a.edge);
  const c = cands[0];
  const dir = c.outcome === 'YES' ? 1 : -1;
  const reasons = [...c.reasons];

  const opposite = openPosition(ctx, s.id, m.conditionId, c.outcome === 'YES' ? 'NO' : 'YES');
  if (opposite) reasons.push('holding the opposite side');
  const existing = openPosition(ctx, s.id, m.conditionId, c.outcome);
  reasons.push(
    ...preTradeReasons(acct, risk, {
      marketActive: m.active && !m.resolved,
      priceAgeSec: 0,
      spread,
      haltAll: haltAll(ctx.conn),
      sessionRunning: s.status === 'running',
      isNewPosition: !existing,
    })
  );
  if (s.mode === 'live') {
    const block = liveBlock(ctx, s);
    if (block) reasons.push(block);
  }
  // correlated cluster: markets in the same event move together
  if (m.eventId) {
    let cluster = 0;
    for (const pos of ctx.conn.db.position.sessionId.filter(s.id)) {
      if (pos.closed) continue;
      if (ctx.hub.market(pos.conditionId)?.eventId === m.eventId) cluster += pos.shares * pos.markPrice;
    }
    const cap = (risk.maxGrossExposurePct / 4) * acct.equityUsd;
    if (cluster >= cap) reasons.push(`event cluster exposure $${cluster.toFixed(0)} ≥ cap $${cap.toFixed(0)}`);
  }
  // ensemble agreement: ≥70% of forecasters on the trade's side of the price
  if (c.strategy === 'value') {
    const fs = [...ctx.conn.db.agentForecast.signalId.filter(signal.id)];
    if (fs.length >= 3) {
      const same = fs.filter(f => (dir > 0 ? f.probYes > mid : f.probYes < mid)).length / fs.length;
      if (same < 0.7) reasons.push(`only ${Math.round(100 * same)}% of forecasters agree on the side`);
    }
  }
  const conf = confirmations(ctx, signal, dir, mid);
  if (p.mode !== 'reflex' && conf.n < 2) reasons.push(`only ${conf.n} independent confirmation(s): ${conf.which.join(', ') || 'none'}`);
  if (p.mode !== 'reflex' && signal.layer === 'pro' && signal.confidence === 0) reasons.push('supervisor marked not tradeable');

  const asks: BookLevel[] = (c.outcome === 'YES' ? yes : no).asks;
  const limits = maxStakeUsd(acct, risk);
  // never take more than 20% of the visible depth within 2¢ of the best price
  const best = asks[0]?.price ?? 1;
  const depthUsd = asks.filter(l => l.price <= best + 0.02).reduce((sum, l) => sum + l.size * l.price, 0);
  if (depthUsd > 0 && 0.2 * depthUsd < limits.usd) {
    limits.usd = 0.2 * depthUsd;
    limits.binding = '20% of visible depth';
  }
  const kellyMult = risk.kellyFraction * (p.mode === 'reflex' ? config.intel.reflexStakeFrac : 1) * Math.max(0.25, conf.conf || 0.5);
  const sizing = sizePosition({
    p: c.p,
    asks,
    equityUsd: acct.equityUsd,
    cashUsd: acct.cashUsd,
    kellyMultiplier: kellyMult,
    maxStakeUsd: limits.usd,
    minEdge: risk.minEdge,
    minShares: yes.minOrderSize ?? m.minOrderSize,
    fee: (shares, price) => (c.postOnly ? 0 : takerFee(m, shares, price)),
  });
  if (sizing.shares <= 0) reasons.push(`sizing: ${sizing.reason} (binding: ${limits.binding})`);

  if (reasons.length > 0) {
    await record('rejected', c, { confirmations: conf.n, confidence: conf.conf, kelly: sizing.fullKellyFraction }, reasons);
    return { result: { verdict: 'rejected', reasons } };
  }

  const tick = m.tickSize || 0.01;
  const outcomeBid = (c.outcome === 'YES' ? yes : no).bids[0]?.price ?? 0;
  const limitPrice = c.postOnly ? Math.min(sizing.limitPrice, Number((outcomeBid + tick).toFixed(6))) : sizing.limitPrice;
  await record(
    'approved',
    c,
    { sizeUsd: sizing.stakeUsd, kelly: sizing.fullKellyFraction, confirmations: conf.n, confidence: conf.conf },
    [`${c.strategy} ${c.outcome}: edge ${(100 * c.edge).toFixed(1)} pts, ${conf.which.join(', ') || 'reflex'}`]
  );
  const fill = await execute(ctx, {
    session: s,
    market: m,
    outcome: c.outcome,
    side: 'BUY',
    size: sizing.shares,
    limitPrice,
    orderType: c.postOnly ? 'GTC' : 'FAK',
    postOnly: c.postOnly,
    decisionRef,
    levels: asks,
    plan: c.plan,
    note: `${c.strategy} via ${signal.layer}`,
  });
  const msg = `${s.mode.toUpperCase()} ${c.strategy} BUY ${c.outcome} ${sizing.shares.toFixed(1)} @ ≤${limitPrice.toFixed(3)} ($${sizing.stakeUsd.toFixed(2)}) → ${fill.status} — ${m.question.slice(0, 90)}`;
  ctx.activity({ sessionId: s.id, level: 'info', kind: 'trade', message: msg, refId: decisionRef });
  await ctx.alerts.send('trade', msg);
  log.info('order', { session: s.id, market: m.slug || m.conditionId.slice(0, 10), status: fill.status, shares: sizing.shares.toFixed(1) });
  return { result: { verdict: 'approved', decisionRef, fill } };
};

// Order execution and bookkeeping.
//
// Paper mode walks the real order book (fresh from the venue), pays the real
// taker fee (shares × rate × p × (1 − p)) and simulates resting maker orders
// that fill only when the market trades through them. Live mode sends the
// same order to the venue and books the venue's fill report. Positions, cash
// and PnL are kept in SpacetimeDB either way.
import type { BookLevel } from '@midas/core';
import type { Market, Position, Session } from '@midas/stdb-bindings/types';
import { config } from '../config';
import type { EngineCtx } from '../ctx';
import { logger } from '../log';
import { ref } from '../util/time';
import { venueFor, type OrderType } from '../venues';
import { rowToVenueMarket } from '../market/hub';
import { readiness } from './readiness';

const log = logger('exec');

export function takerFee(market: Market, shares: number, price: number): number {
  return Math.round(shares * market.feeRate * price * (1 - price) * 1e5) / 1e5;
}

export interface ExitPlan {
  strategy: string;
  targetPrice: number;
  stopPrice: number;
  timeStopMs: number;
}

export interface OrderRequest {
  session: Session;
  market: Market;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  /** shares */
  size: number;
  /** worst acceptable price (BUY: max, SELL: min) */
  limitPrice: number;
  orderType: OrderType;
  postOnly: boolean;
  decisionRef: string;
  levels: BookLevel[];
  plan?: ExitPlan;
  note: string;
}

export function openPosition(ctx: EngineCtx, sessionId: bigint, conditionId: string, outcome: string): Position | undefined {
  for (const p of ctx.conn.db.position.sessionId.filter(sessionId)) {
    if (!p.closed && p.conditionId === conditionId && p.outcome === outcome) return p;
  }
  return undefined;
}

/** Is live trading allowed for this session right now? Returns the blocking reason. */
export function liveBlock(ctx: EngineCtx, s: Session): string | undefined {
  if (!config.live.enabled) return 'MIDAS_LIVE_TRADING is off';
  if (!s.liveApproved) return 'session not approved for live trading';
  if (s.bankrollUsd > config.live.maxSessionBankrollUsd) return `bankroll above MIDAS_LIVE_MAX_BANKROLL_USD (${config.live.maxSessionBankrollUsd})`;
  if (config.live.requireReadiness) {
    const r = readiness(ctx.conn);
    if (!r.ready) return `not ready for live: ${r.reasons.join('; ')}`;
  }
  return undefined;
}

interface FillResult {
  filled: number;
  avgPrice: number;
  fee: number;
  status: string;
  externalId: string;
  error?: string;
}

function paperFill(req: OrderRequest): FillResult {
  if (req.postOnly) return { filled: 0, avgPrice: 0, fee: 0, status: 'open', externalId: '' };
  if (req.side === 'BUY') {
    const capped = req.levels.filter(l => l.price <= req.limitPrice + 1e-9);
    let remaining = req.size;
    let cost = 0;
    let fee = 0;
    for (const l of capped) {
      if (remaining <= 1e-9) break;
      const take = Math.min(l.size, remaining);
      cost += take * l.price;
      fee += takerFee(req.market, take, l.price);
      remaining -= take;
    }
    const filled = req.size - remaining;
    return { filled, avgPrice: filled > 0 ? cost / filled : 0, fee, status: filled >= req.size - 1e-6 ? 'filled' : filled > 0 ? 'partial' : 'cancelled', externalId: '' };
  }
  // SELL into bids (best first)
  let remaining = req.size;
  let proceeds = 0;
  let fee = 0;
  for (const l of req.levels.filter(l => l.price >= req.limitPrice - 1e-9)) {
    if (remaining <= 1e-9) break;
    const take = Math.min(l.size, remaining);
    proceeds += take * l.price;
    fee += takerFee(req.market, take, l.price);
    remaining -= take;
  }
  const filled = req.size - remaining;
  return { filled, avgPrice: filled > 0 ? proceeds / filled : 0, fee, status: filled >= req.size - 1e-6 ? 'filled' : filled > 0 ? 'partial' : 'cancelled', externalId: '' };
}

async function liveFill(ctx: EngineCtx, req: OrderRequest): Promise<FillResult> {
  const venue = venueFor(req.market.conditionId);
  const vm = rowToVenueMarket(req.market);
  const tokenId = req.outcome === 'YES' ? vm.yesTokenId : vm.noTokenId;
  const cappedSize = req.side === 'BUY' ? Math.min(req.size, config.live.maxOrderUsd / Math.max(0.01, req.limitPrice)) : req.size;
  const ack = await venue.placeOrder({
    market: vm,
    outcome: req.outcome,
    tokenId,
    side: req.side,
    price: req.limitPrice,
    size: cappedSize,
    orderType: req.orderType,
    postOnly: req.postOnly,
  });
  if (!ack.ok) log.warn('live order rejected', { market: req.market.slug, err: ack.error });
  return {
    filled: ack.filledSize,
    avgPrice: ack.avgPrice,
    fee: ack.filledSize > 0 && !req.postOnly ? takerFee(req.market, ack.filledSize, ack.avgPrice) : 0,
    status: ack.status,
    externalId: ack.externalId,
    error: ack.error,
  };
}

/** Place (or simulate) an order and update order, position and cash. */
export async function execute(ctx: EngineCtx, req: OrderRequest): Promise<FillResult> {
  const live = req.session.mode === 'live';
  if (live) {
    const block = liveBlock(ctx, req.session);
    if (block) return { filled: 0, avgPrice: 0, fee: 0, status: 'rejected', externalId: '', error: block };
  }
  const fill = live ? await liveFill(ctx, req) : paperFill(req);
  const orderRef = ref('ord');
  await ctx.conn.reducers.upsertOrders({
    orders: [
      {
        ref: orderRef,
        sessionId: req.session.id,
        decisionRef: req.decisionRef,
        conditionId: req.market.conditionId,
        tokenId: req.outcome === 'YES' ? req.market.yesTokenId : req.market.noTokenId,
        outcome: req.outcome,
        side: req.side,
        price: req.limitPrice,
        size: req.size,
        status: fill.status,
        mode: req.session.mode,
        externalId: fill.externalId,
        filledSize: fill.filled,
        avgFillPrice: fill.avgPrice,
        feeUsd: fill.fee,
        note: (fill.error ? `${req.note} | ${fill.error}` : req.note).slice(0, 500),
      },
    ],
  });
  if (fill.filled > 0) await book(ctx, req, fill);
  return fill;
}

/**
 * Apply a fill to position + session cash (the same ledger for paper and live).
 * The arithmetic runs inside the `bookFill` reducer so concurrent workers
 * cannot overwrite each other's cash or share counts.
 */
export async function book(ctx: EngineCtx, req: Pick<OrderRequest, 'session' | 'market' | 'outcome' | 'side' | 'plan'>, fill: { filled: number; avgPrice: number; fee: number }) {
  await ctx.conn.reducers.bookFill({
    fill: {
      sessionId: req.session.id,
      conditionId: req.market.conditionId,
      outcome: req.outcome,
      side: req.side,
      shares: fill.filled,
      price: fill.avgPrice,
      fee: fill.fee,
      strategy: req.plan?.strategy ?? '',
      targetPrice: req.plan?.targetPrice ?? 0,
      stopPrice: req.plan?.stopPrice ?? 0,
      timeStopMicros: BigInt(Math.round(req.plan?.timeStopMs ?? 0)) * 1000n,
    },
  });
}

/** Paper resting orders fill when the market trades through the limit. */
export async function simulateRestingOrders(ctx: EngineCtx) {
  const now = Date.now();
  for (const o of [...ctx.conn.db.tradeOrder.iter()]) {
    if (o.status !== 'open' || o.mode !== 'paper') continue;
    const s = ctx.conn.db.session.id.find(o.sessionId);
    const m = ctx.hub.market(o.conditionId);
    const px = ctx.hub.price(o.conditionId);
    if (!s || !m || !px) continue;
    const ageMin = (now - Number(o.createdAt.microsSinceUnixEpoch / 1000n)) / 60_000;
    // outcome-space best ask / best bid
    const ask = o.outcome === 'YES' ? px.ask : 1 - px.bid;
    const bid = o.outcome === 'YES' ? px.bid : 1 - px.ask;
    const crossed = o.side === 'BUY' ? ask <= o.price : bid >= o.price;
    if (crossed && s.status === 'running') {
      await ctx.conn.reducers.upsertOrders({
        orders: [{ ...o, status: 'filled', filledSize: o.size, avgFillPrice: o.price, feeUsd: 0 }],
      });
      await book(ctx, { session: s, market: m, outcome: o.outcome as 'YES' | 'NO', side: o.side as 'BUY' | 'SELL' }, { filled: o.size, avgPrice: o.price, fee: 0 });
      ctx.activity({ sessionId: s.id, level: 'info', kind: 'fill', message: `maker fill ${o.side} ${o.size.toFixed(1)} ${o.outcome} @ ${o.price.toFixed(3)} — ${m.question.slice(0, 80)}`, refId: o.ref });
    } else if (ageMin > 360 || s.status !== 'running') {
      await ctx.conn.reducers.upsertOrders({ orders: [{ ...o, status: 'cancelled', note: `${o.note} | expired` }] });
    }
  }
}

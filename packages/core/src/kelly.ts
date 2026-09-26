// Position sizing for binary prediction-market shares.
//
// Buying one YES share at price c pays 1 if YES. With belief p, the growth-
// optimal bankroll fraction is f* = (p − c) / (1 − c). We bet a fraction of
// that (fractional Kelly) because p is an estimate, and we walk the order book
// so the price we size against is the price we would actually pay.

export interface BookLevel {
  price: number;
  /** shares available at this price */
  size: number;
}

/** Fee in USD for filling `shares` at `price`. */
export type FeeFn = (shares: number, price: number) => number;

export const NO_FEES: FeeFn = () => 0;

/**
 * Fee schedules. 'notional': rate × shares × price. 'pq': rate × shares ×
 * price × (1 − price) — highest at 50¢, vanishing at the extremes.
 */
export function makeFeeFn(rate: number, model: 'notional' | 'pq' = 'pq'): FeeFn {
  if (!(rate > 0)) return NO_FEES;
  return model === 'notional'
    ? (shares, price) => rate * shares * price
    : (shares, price) => rate * shares * price * (1 - price);
}

export function kellyFraction(p: number, price: number): number {
  if (!(price > 0 && price < 1)) return 0;
  return Math.max(0, (p - price) / (1 - price));
}

export interface Fill {
  shares: number;
  costUsd: number;
  avgPrice: number;
  worstPrice: number;
  feeUsd: number;
  levelsUsed: number;
}

/** Walk ascending asks spending at most `budgetUsd` (fees included). */
export function walkBook(asks: BookLevel[], budgetUsd: number, fee: FeeFn = NO_FEES, maxPrice = 1): Fill {
  const levels = [...asks].filter(l => l.size > 0 && l.price > 0 && l.price < 1).sort((a, b) => a.price - b.price);
  let remaining = budgetUsd;
  let shares = 0;
  let cost = 0;
  let fees = 0;
  let worst = 0;
  let used = 0;
  for (const lvl of levels) {
    if (remaining <= 1e-9 || lvl.price > maxPrice) break;
    const perShare = lvl.price + fee(1, lvl.price);
    const take = Math.min(lvl.size, remaining / perShare);
    if (take <= 0) break;
    const f = fee(take, lvl.price);
    shares += take;
    cost += take * lvl.price;
    fees += f;
    remaining -= take * lvl.price + f;
    worst = lvl.price;
    used++;
  }
  return {
    shares,
    costUsd: cost + fees,
    avgPrice: shares > 0 ? cost / shares : 0,
    worstPrice: worst,
    feeUsd: fees,
    levelsUsed: used,
  };
}

export interface SizingInput {
  /** calibrated, market-blended probability that this outcome happens */
  p: number;
  /** asks for the outcome being bought (YES asks, or NO asks) */
  asks: BookLevel[];
  equityUsd: number;
  cashUsd: number;
  /** fractional Kelly multiplier, e.g. 0.25 */
  kellyMultiplier: number;
  /** hard cap for this position in USD (risk limits already applied) */
  maxStakeUsd: number;
  /** minimum edge per share after fees, in probability points */
  minEdge: number;
  /** venue minimum order size in shares */
  minShares?: number;
  fee?: FeeFn;
}

export interface Sizing extends Fill {
  stakeUsd: number;
  edgeAtAvg: number;
  fullKellyFraction: number;
  limitPrice: number;
  reason: string;
}

const EMPTY_FILL: Fill = { shares: 0, costUsd: 0, avgPrice: 0, worstPrice: 0, feeUsd: 0, levelsUsed: 0 };

export function sizePosition(input: SizingInput): Sizing {
  const fee = input.fee ?? NO_FEES;
  const best = [...input.asks].filter(l => l.size > 0).sort((a, b) => a.price - b.price)[0];
  const none = (reason: string): Sizing => ({
    ...EMPTY_FILL,
    stakeUsd: 0,
    edgeAtAvg: 0,
    fullKellyFraction: 0,
    limitPrice: 0,
    reason,
  });
  if (!best) return none('empty book');
  // Only levels that still clear minEdge after fees are worth buying.
  const maxPrice = input.p - input.minEdge;
  const bestEdge = input.p - best.price - fee(1, best.price);
  if (bestEdge < input.minEdge) return none(`edge ${bestEdge.toFixed(3)} < min ${input.minEdge}`);

  let price = best.price;
  let stake = 0;
  let fill: Fill = EMPTY_FILL;
  // Fixed point: size at the average price that size would actually get.
  for (let i = 0; i < 6; i++) {
    const f = kellyFraction(input.p, price);
    stake = Math.min(
      f * input.kellyMultiplier * input.equityUsd,
      input.maxStakeUsd,
      Math.max(0, input.cashUsd)
    );
    fill = walkBook(input.asks, stake, fee, maxPrice);
    if (fill.shares <= 0) break;
    const next = fill.avgPrice + fill.feeUsd / fill.shares;
    if (Math.abs(next - price) < 1e-6) break;
    price = next;
  }
  if (fill.shares <= 0) return none('no liquidity within edge');
  if (input.minShares && fill.shares < input.minShares) return none(`below venue minimum ${input.minShares} shares`);
  const effective = fill.costUsd / fill.shares;
  return {
    ...fill,
    stakeUsd: fill.costUsd,
    edgeAtAvg: input.p - effective,
    fullKellyFraction: kellyFraction(input.p, effective),
    limitPrice: fill.worstPrice,
    reason: 'ok',
  };
}

/** Best bid/ask of the NO token implied by the YES book (complementary). */
export function complementBook(yesBids: BookLevel[]): BookLevel[] {
  return yesBids.map(l => ({ price: Math.round((1 - l.price) * 1e6) / 1e6, size: l.size }));
}

/** Expected log-growth of a bet: p·ln(1 + f·b) + (1−p)·ln(1 − f), b = (1−c)/c. */
export function expectedLogGrowth(p: number, price: number, f: number): number {
  if (f <= 0) return 0;
  if (f >= 1) return -Infinity;
  const b = (1 - price) / price;
  return p * Math.log(1 + f * b) + (1 - p) * Math.log(1 - f);
}

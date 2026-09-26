// News-shock reaction model.
//
// After a headline, a market's price is modelled as moving by Δ toward a new
// level, with the move absorbed exponentially: the fraction still to come
// after t minutes is 2^(−t / halfLife). The realized reaction is measured on
// 1-minute bars at fixed horizons and scored against the forecast.
import { clampProb, logit, sigmoid } from './prob';

export interface Bar {
  tsMs: number;
  close: number;
}

/**
 * Price move implied by a log-odds evidence shift at the current price. Blind
 * forecasters report evidence strength (log likelihood ratio); the move it
 * causes depends on where the price is: +0.7 moves 50¢→67¢ but 95¢→97¢.
 */
export function deltaFromShift(p0: number, shift: number): number {
  const p = clampProb(p0);
  return sigmoid(logit(p) + shift) - p;
}

/** Fraction of the move still to come after `elapsedMin`. */
export function remainingFraction(halfLifeMin: number, elapsedMin: number): number {
  if (!(halfLifeMin > 0)) return 0;
  return Math.pow(0.5, Math.max(0, elapsedMin) / halfLifeMin);
}

export function remainingMove(delta: number, halfLifeMin: number, elapsedMin: number): number {
  return delta * remainingFraction(halfLifeMin, elapsedMin);
}

/**
 * Where the price should be at `elapsedMin`, applying the shock in log-odds
 * so it never leaves (0, 1). p0 = price when the news hit.
 */
export function expectedPriceAt(p0: number, delta: number, halfLifeMin: number, elapsedMin: number): number {
  const target = clampProb(p0 + delta, 0.005);
  const lt = logit(target);
  const l0 = logit(p0);
  const frac = 1 - remainingFraction(halfLifeMin, elapsedMin);
  return sigmoid(l0 + (lt - l0) * frac);
}

/**
 * Overlay a news shock on a baseline path (e.g. TimesFM point forecast).
 * The baseline knows nothing of the headline; we add the part of the move not
 * yet absorbed at each step.
 */
export function overlayShock(
  baseline: number[],
  stepSec: number,
  delta: number,
  halfLifeMin: number,
  elapsedMin: number
): number[] {
  return baseline.map((b, i) => {
    const tMin = elapsedMin + ((i + 1) * stepSec) / 60;
    const still = remainingMove(delta, halfLifeMin, elapsedMin) - remainingMove(delta, halfLifeMin, tMin);
    return clampProb(b + still, 0.001);
  });
}

/** Close price at or before `tsMs` (bars sorted ascending). */
export function priceAt(bars: Bar[], tsMs: number): number | undefined {
  let lo = 0;
  let hi = bars.length - 1;
  let ans: number | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].tsMs <= tsMs) {
      ans = bars[mid].close;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Realized Δ `horizonMin` after the news; undefined until that time exists in the bars. */
export function realizedDelta(bars: Bar[], newsTsMs: number, horizonMin: number, p0?: number): number | undefined {
  if (bars.length === 0) return undefined;
  const end = newsTsMs + horizonMin * 60_000;
  if (bars[bars.length - 1].tsMs < end) return undefined;
  const start = p0 ?? priceAt(bars, newsTsMs);
  const after = priceAt(bars, end);
  if (start === undefined || after === undefined) return undefined;
  return after - start;
}

export interface ReactionScore {
  absError: number;
  /** 1 if predicted and realized directions agree (ignoring tiny moves) */
  directionHit: number;
  /** did the realized move land inside the forecast [q10, q90] band? */
  covered: boolean;
}

export function scoreReaction(
  predicted: { delta: number; q10: number; q90: number },
  realized: number,
  deadband = 0.005
): ReactionScore {
  const pd = Math.abs(predicted.delta) < deadband ? 0 : Math.sign(predicted.delta);
  const rd = Math.abs(realized) < deadband ? 0 : Math.sign(realized);
  return {
    absError: Math.abs(predicted.delta - realized),
    directionHit: pd === rd ? 1 : 0,
    covered: realized >= Math.min(predicted.q10, predicted.q90) && realized <= Math.max(predicted.q10, predicted.q90),
  };
}

/**
 * Estimate half-life from a realized path: minutes until half of the move to
 * `horizonMin` was done. Used to label analogs for future priors.
 */
export function estimateHalfLife(bars: Bar[], newsTsMs: number, horizonMin: number): number | undefined {
  const total = realizedDelta(bars, newsTsMs, horizonMin);
  const p0 = priceAt(bars, newsTsMs);
  if (total === undefined || p0 === undefined || Math.abs(total) < 1e-6) return undefined;
  for (const b of bars) {
    if (b.tsMs <= newsTsMs) continue;
    if ((b.close - p0) / total >= 0.5) return Math.max(0.5, (b.tsMs - newsTsMs) / 60_000);
  }
  return undefined;
}

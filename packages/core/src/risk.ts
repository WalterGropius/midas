// Risk gates. Deterministic, boring, and always consulted before an order.
// Risk of ruin ends the game; everything here exists to keep playing.

export interface RiskLimits {
  kellyFraction: number;
  maxPositionPct: number;
  maxGrossExposurePct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  minEdge: number;
  maxSpread: number;
  modelTrust: number;
  maxOpenPositions: number;
  strategy: string;
}

// Defaults follow the research notes (docs/RESEARCH.md): quarter Kelly on a
// market-blended probability, small per-market caps, 40% gross, stop new risk
// at a 15% drawdown, model weight ≈0.25 against the market price.
export const DEFAULT_RISK: RiskLimits = {
  kellyFraction: 0.25,
  maxPositionPct: 0.03,
  maxGrossExposurePct: 0.4,
  maxDailyLossPct: 0.05,
  maxDrawdownPct: 0.15,
  minEdge: 0.02,
  maxSpread: 0.05,
  modelTrust: 0.25,
  maxOpenPositions: 15,
  strategy: 'both',
};

export const RISK_PRESETS: Record<'conservative' | 'balanced' | 'aggressive', RiskLimits> = {
  conservative: { ...DEFAULT_RISK, kellyFraction: 0.15, maxPositionPct: 0.02, maxGrossExposurePct: 0.25, maxDrawdownPct: 0.1, minEdge: 0.03, modelTrust: 0.2 },
  balanced: DEFAULT_RISK,
  aggressive: { ...DEFAULT_RISK, kellyFraction: 0.35, maxPositionPct: 0.06, maxGrossExposurePct: 0.6, maxDailyLossPct: 0.08, maxDrawdownPct: 0.25, minEdge: 0.015, modelTrust: 0.35 },
};

export interface AccountState {
  equityUsd: number;
  cashUsd: number;
  peakEquityUsd: number;
  dayStartEquityUsd: number;
  /** current market value of open positions */
  exposureUsd: number;
  openPositions: number;
  /** exposure already held in the market being considered */
  exposureInMarketUsd: number;
}

export type Breaker = 'none' | 'daily_loss' | 'drawdown';

export function circuitBreaker(acct: AccountState, limits: RiskLimits): Breaker {
  if (acct.peakEquityUsd > 0 && (acct.peakEquityUsd - acct.equityUsd) / acct.peakEquityUsd >= limits.maxDrawdownPct) {
    return 'drawdown';
  }
  if (
    acct.dayStartEquityUsd > 0 &&
    (acct.dayStartEquityUsd - acct.equityUsd) / acct.dayStartEquityUsd >= limits.maxDailyLossPct
  ) {
    return 'daily_loss';
  }
  return 'none';
}

/** Largest additional stake in this market that every limit still allows. */
export function maxStakeUsd(acct: AccountState, limits: RiskLimits): { usd: number; binding: string } {
  const perMarket = limits.maxPositionPct * acct.equityUsd - acct.exposureInMarketUsd;
  const gross = limits.maxGrossExposurePct * acct.equityUsd - acct.exposureUsd;
  const cash = acct.cashUsd;
  const candidates: [number, string][] = [
    [perMarket, 'max position'],
    [gross, 'gross exposure'],
    [cash, 'cash'],
  ];
  let best: [number, string] = [Infinity, 'none'];
  for (const c of candidates) if (c[0] < best[0]) best = c;
  return { usd: Math.max(0, best[0]), binding: best[1] };
}

export interface PreTradeCheck {
  marketActive: boolean;
  priceAgeSec: number;
  spread: number;
  haltAll: boolean;
  sessionRunning: boolean;
  isNewPosition: boolean;
}

export function preTradeReasons(acct: AccountState, limits: RiskLimits, chk: PreTradeCheck): string[] {
  const reasons: string[] = [];
  if (chk.haltAll) reasons.push('global halt is on');
  if (!chk.sessionRunning) reasons.push('session not running');
  if (!chk.marketActive) reasons.push('market not active');
  if (chk.priceAgeSec > 90) reasons.push(`stale price (${Math.round(chk.priceAgeSec)}s old)`);
  if (chk.spread > limits.maxSpread) reasons.push(`spread ${chk.spread.toFixed(3)} > ${limits.maxSpread}`);
  if (chk.isNewPosition && acct.openPositions >= limits.maxOpenPositions) reasons.push('max open positions reached');
  const breaker = circuitBreaker(acct, limits);
  if (breaker !== 'none') reasons.push(`circuit breaker: ${breaker}`);
  return reasons;
}

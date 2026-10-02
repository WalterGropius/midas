// $500 for 6 months, simulated with MIDAS's own sizing and risk code.
//
// The explainer video needs an ROI answer that is honest: the one thing no
// simulation can know is whether the forecasts carry real edge, so that is
// the scenario knob and everything else is production code from @midas/core
// (fractional Kelly walked through the book, per-market / gross / cash caps,
// taker fees, the daily-loss pause and the drawdown kill switch).
//
//   npx tsx docs/explainer/roi-sim.ts   # rewrites the ROI block in midas-explainer.html
//
// Simplifications, all on the conservative side for variance: every trade is
// held to a binary payoff (reaction trades really exit on target/stop),
// markets are independent (the engine's event-cluster cap is not modelled),
// and LLM spend is reported separately because it is a fixed cost.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  RISK_PRESETS,
  circuitBreaker,
  independentConfirmation,
  makeFeeFn,
  maxStakeUsd,
  mulberry32,
  sizePosition,
  type BookLevel,
  type RiskLimits,
} from '@midas/core';

const BANKROLL = 500;
const DAYS = 182;
const PATHS = 4000;
// trade candidates per day that clear every gate (hurdle, price band, 72 h,
// confirmations) across a ~15-market watchlist, before capacity limits
const CANDIDATES_PER_DAY = 2.5;
// MIDAS_LIVE_MAX_ORDER_USD default
const MAX_ORDER_USD = 25;
// assumed LLM budget for a lean single-session setup (MIDAS_LLM_DAILY_BUDGET_USD)
const LLM_USD_PER_DAY = 1;
// Polymarket taker fee rates by category (geopolitics 0, politics/finance 0.04, economics 0.05)
const FEE_RATES = [0, 0.04, 0.04, 0.05];
const CONFIRMATIONS = [0.6, 0.5, 0.5, 0.45, 0.35, 0.3];
const NO_FEE = makeFeeFn(0);
// news-reaction trades (taker, minutes to hours) vs value trades (mostly maker, days to weeks)
const REACTION_SHARE = 0.55;

interface Scenario {
  key: string;
  label: string;
  /** share of the edge the system claims that is real: 0 = forecasts are noise */
  realized: number;
}

// Value trades blend the forecast with the market at modelTrust 0.25, so the
// claimed edge is 0.25 × the raw disagreement. If the optimal weight is
// really w*, the real edge is (w* / 0.25) of the claimed one: w* = 0.2 is the
// research optimum (Halawi et al.: 4:1 crowd:model), w* = 0 means the
// forecasts add nothing beyond the price.
const SCENARIOS: Scenario[] = [
  { key: 'bear', label: 'Model adds nothing (w* = 0)', realized: 0 },
  { key: 'base', label: 'Half the research optimum (w* = 0.10)', realized: 0.4 },
  { key: 'bull', label: 'Research optimum holds (w* = 0.20)', realized: 0.8 },
];

interface Position {
  stake: number;
  /** cash returned on exit, drawn when the trade opens */
  payout: number;
  exitDay: number;
  openDay: number;
}

interface PathResult {
  curve: number[];
  trades: number;
  reactionTrades: number;
  staked: number;
  edgeSum: number;
  killed: boolean;
}

function poisson(rng: () => number, lambda: number): number {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > l);
  return k - 1;
}

function expo(rng: () => number, mean: number): number {
  return -Math.log(1 - rng()) * mean;
}

function gauss(rng: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function simulate(rng: () => number, risk: RiskLimits, realized: number): PathResult {
  let cash = BANKROLL;
  let peak = BANKROLL;
  let positions: Position[] = [];
  let killed = false;
  let trades = 0;
  let reactionTrades = 0;
  let staked = 0;
  let edgeSum = 0;
  const curve: number[] = [BANKROLL];
  // open positions are carried at cost until they exit
  const equity = () => cash + positions.reduce((s, p) => s + p.stake, 0);

  for (let day = 1; day <= DAYS; day++) {
    const keep: Position[] = [];
    for (const p of positions) {
      if (p.exitDay > day) keep.push(p);
      else cash += p.payout;
    }
    positions = keep;
    const dayStart = equity();
    peak = Math.max(peak, dayStart);

    const n = poisson(rng, CANDIDATES_PER_DAY);
    for (let i = 0; i < n && !killed; i++) {
      const eq = equity();
      const acct = {
        equityUsd: eq,
        cashUsd: cash,
        peakEquityUsd: peak,
        dayStartEquityUsd: dayStart,
        exposureUsd: eq - cash,
        openPositions: positions.length,
        exposureInMarketUsd: 0,
      };
      const breaker = circuitBreaker(acct, risk);
      if (breaker === 'drawdown') {
        killed = true;
        break;
      }
      if (breaker === 'daily_loss' || positions.length >= risk.maxOpenPositions) break;

      const mid = 0.15 + 0.7 * rng();
      const spread = 0.01 + 0.03 * rng();
      const feeRate = FEE_RATES[Math.floor(rng() * FEE_RATES.length)];
      const takerFee = makeFeeFn(feeRate);
      const reaction = rng() < REACTION_SHARE;

      const picked = CONFIRMATIONS.filter(() => rng() < 0.45);
      if (!reaction && picked.length < 2) continue;
      const conf = Math.max(0.25, independentConfirmation(picked) || 0.5);

      let entry: number;
      let pModel: number;
      let fee = takerFee;
      let settle: (shares: number) => number;
      let hold: number;
      let claimed: number;
      if (reaction) {
        // trade the predicted move; skip when ≥50% already happened
        const delta = 0.015 + expo(rng, 0.04);
        const moved = 0.5 * delta * rng();
        const remaining = delta - moved;
        entry = mid + spread / 2;
        pModel = Math.min(0.99, mid + remaining);
        claimed = remaining;
        const target = entry + 0.8 * (pModel - entry);
        const stop = entry - 0.8 * delta;
        const drift = realized * remaining;
        const move = drift + (0.5 * delta + 0.01) * gauss(rng);
        // exits sell into the bid as a taker: the round trip pays the spread and two fees
        const exitBid = clamp(mid + move - spread / 2, stop, target);
        settle = shares => Math.max(0, shares * exitBid - takerFee(shares, exitBid));
        hold = 1;
      } else {
        // value: fair value is the forecast blended with the market at modelTrust
        const disagreement = 0.05 + 0.4 * rng();
        const postOnly = spread >= 0.02;
        if (postOnly && rng() > 0.55) continue; // resting maker order never filled
        entry = mid;
        fee = postOnly ? NO_FEE : takerFee;
        const hurdle = risk.minEdge + spread / 2 + takerFee(1, mid) + 1.5 * disagreement * mid * (1 - mid);
        const gap = hurdle + expo(rng, 0.015);
        pModel = Math.min(0.97, mid + gap);
        claimed = gap;
        // makers get filled more often when they are wrong
        const pTrue = clamp(mid + realized * gap - (postOnly ? 0.0075 : 0) + 0.02 * gauss(rng), 0.01, 0.99);
        const win = rng() < pTrue;
        settle = shares => (win ? shares : 0);
        hold = 3 + expo(rng, 15);
      }

      const depthUsd = 150 + expo(rng, 1500);
      const asks: BookLevel[] = [0, 0.01, 0.02, 0.03].map(d => ({ price: entry + d, size: depthUsd / 3 / (entry + d) }));
      const limits = maxStakeUsd(acct, risk);
      const sizing = sizePosition({
        p: pModel,
        asks,
        equityUsd: eq,
        cashUsd: cash,
        kellyMultiplier: risk.kellyFraction * conf,
        maxStakeUsd: Math.min(limits.usd, 0.2 * depthUsd, MAX_ORDER_USD),
        minEdge: risk.minEdge,
        minShares: 5,
        fee,
      });
      if (sizing.shares <= 0) continue;
      cash -= sizing.costUsd;
      staked += sizing.costUsd;
      edgeSum += realized * claimed * sizing.costUsd;
      trades++;
      if (reaction) reactionTrades++;
      positions.push({
        stake: sizing.costUsd,
        payout: settle(sizing.shares),
        openDay: day,
        exitDay: day + Math.max(1, Math.round(hold)),
      });
    }
    curve.push(equity());
  }
  return { curve, trades, reactionTrades, staked, edgeSum, killed };
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function run(preset: RiskLimits, seed: number) {
  return SCENARIOS.map((sc, k) => {
    const rng = mulberry32(seed + k * 7919);
    const paths: PathResult[] = [];
    for (let i = 0; i < PATHS; i++) paths.push(simulate(rng, preset, sc.realized));
    const step = 7;
    const days: number[] = [];
    for (let d = 0; d <= DAYS; d += step) days.push(d);
    if (days[days.length - 1] !== DAYS) days.push(DAYS);
    const bands = days.map(d => {
      const col = paths.map(p => p.curve[d]).sort((a, b) => a - b);
      return [0.1, 0.25, 0.5, 0.75, 0.9].map(q => round(quantile(col, q)));
    });
    const finals = paths.map(p => p.curve[DAYS]).sort((a, b) => a - b);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      key: sc.key,
      label: sc.label,
      realized: sc.realized,
      // realized edge per dollar staked, in probability points
      edgePp: round((100 * mean(paths.map(p => p.edgeSum))) / Math.max(1, mean(paths.map(p => p.staked))), 2),
      reactionShare: round(mean(paths.map(p => p.reactionTrades / Math.max(1, p.trades))), 2),
      days,
      bands,
      p10: round(quantile(finals, 0.1)),
      p50: round(quantile(finals, 0.5)),
      p90: round(quantile(finals, 0.9)),
      mean: round(mean(finals)),
      pLoss: round(finals.filter(f => f < BANKROLL).length / finals.length, 3),
      pKill: round(paths.filter(p => p.killed).length / paths.length, 3),
      trades: Math.round(mean(paths.map(p => p.trades))),
      staked: Math.round(mean(paths.map(p => p.staked))),
      samples: paths.slice(0, 10).map(p => days.map(d => round(p.curve[d]))),
    };
  });
}

const balanced = run(RISK_PRESETS.balanced, 20261002);
const aggressive = run(RISK_PRESETS.aggressive, 20261003);
const data = {
  bankroll: BANKROLL,
  days: DAYS,
  paths: PATHS,
  candidatesPerDay: CANDIDATES_PER_DAY,
  llmUsdPerDay: LLM_USD_PER_DAY,
  llmUsd6mo: LLM_USD_PER_DAY * DAYS,
  balanced,
  aggressive: aggressive.map(({ samples, bands, days, ...rest }) => rest),
};

for (const [name, set] of [['balanced', balanced], ['aggressive', aggressive]] as const) {
  console.log(`\n${name}`);
  for (const s of set) {
    console.log(
      `  ${s.label.padEnd(26)} P10 $${s.p10}  P50 $${s.p50}  P90 $${s.p90}  mean $${s.mean}  P(loss) ${s.pLoss}  P(kill) ${s.pKill}  trades ${s.trades}  staked $${s.staked}`
    );
  }
}

const file = new URL('./midas-explainer.html', import.meta.url);
const html = readFileSync(file, 'utf8');
const block = `/*ROI:BEGIN*/window.ROI=${JSON.stringify(data)};/*ROI:END*/`;
const next = html.replace(/\/\*ROI:BEGIN\*\/[\s\S]*?\/\*ROI:END\*\//, block);
if (next === html && !html.includes(block)) throw new Error('ROI markers not found in midas-explainer.html');
writeFileSync(file, next);
console.log('\nwrote ROI block into midas-explainer.html');

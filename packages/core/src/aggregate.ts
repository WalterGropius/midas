// Ensemble aggregation ("wisdom of the silicon crowd").
//
// Individual forecasters → weighted, trimmed mean in log-odds → extremize →
// shrink toward the market price. Extremizing corrects for the fact that each
// forecaster only sees part of the evidence (Satopää et al. 2014); shrinking
// toward the market respects that liquid prices already aggregate a lot.
import { clampProb, logit, mean, sigmoid, std } from './prob';

export interface MemberForecast {
  prob: number;
  weight?: number;
}

export interface AggregateOptions {
  /** fraction trimmed from EACH tail by weight (0.1 = drop top/bottom 10%) */
  trim?: number;
  /** multiply the pooled log-odds by this factor (1 = none) */
  extremize?: number;
}

export interface Aggregate {
  prob: number;
  pooledLogit: number;
  /** standard deviation of member log-odds — the disagreement signal */
  disagreement: number;
  n: number;
}

export function aggregateForecasts(members: MemberForecast[], opts: AggregateOptions = {}): Aggregate {
  const trim = opts.trim ?? 0.1;
  const extremize = opts.extremize ?? 1.3;
  const rows = members
    .filter(m => Number.isFinite(m.prob))
    .map(m => ({ l: logit(m.prob), w: Math.max(0, m.weight ?? 1) }))
    .sort((a, b) => a.l - b.l);
  if (rows.length === 0) return { prob: 0.5, pooledLogit: 0, disagreement: 0, n: 0 };
  const total = rows.reduce((s, r) => s + r.w, 0) || rows.length;
  const lo = total * trim;
  const hi = total * (1 - trim);
  let acc = 0;
  let sw = 0;
  let sl = 0;
  for (const r of rows) {
    const w = r.w || 1 / rows.length;
    const start = acc;
    const end = acc + w;
    acc = end;
    // weight of this member that survives the trim window [lo, hi]
    const kept = Math.max(0, Math.min(end, hi) - Math.max(start, lo));
    sw += kept;
    sl += kept * r.l;
  }
  const pooled = sw > 0 ? sl / sw : mean(rows.map(r => r.l));
  const l = pooled * extremize;
  return {
    prob: sigmoid(l),
    pooledLogit: l,
    disagreement: std(rows.map(r => r.l)),
    n: rows.length,
  };
}

/**
 * Blend the model probability with the market price in log-odds space.
 * trust = 0 → pure market; trust = 1 → pure model.
 */
export function blendWithMarket(pModel: number, pMarket: number, trust: number): number {
  const w = Math.min(1, Math.max(0, trust));
  return sigmoid(w * logit(pModel) + (1 - w) * logit(clampProb(pMarket)));
}

/**
 * Hedge / multiplicative weights from cumulative losses. Lower loss → more
 * weight. eta controls how fast the ensemble concentrates on winners.
 */
export function hedgeWeights(cumLosses: number[], eta = 2): number[] {
  if (cumLosses.length === 0) return [];
  const min = Math.min(...cumLosses);
  const raw = cumLosses.map(l => Math.exp(-eta * (l - min)));
  const s = raw.reduce((a, b) => a + b, 0);
  return raw.map(r => r / s);
}

/**
 * Multi-source confirmation: independent evidence multiplies. With per-source
 * confidences c_i the probability that ALL are wrong is Π(1 − c_i).
 * Only pass genuinely independent sources (not three agents reading the same
 * headline with the same prompt).
 */
export function independentConfirmation(confidences: number[]): number {
  let allWrong = 1;
  for (const c of confidences) allWrong *= 1 - Math.min(0.999, Math.max(0, c));
  return 1 - allWrong;
}

/** Aggregate reaction forecasts (Δprob) robustly: weighted median + spread. */
export function aggregateDeltas(
  deltas: { delta: number; weight?: number }[]
): { median: number; q10: number; q90: number; agreement: number } {
  if (deltas.length === 0) return { median: 0, q10: 0, q90: 0, agreement: 0 };
  const sorted = [...deltas].sort((a, b) => a.delta - b.delta);
  const total = sorted.reduce((s, d) => s + Math.max(0, d.weight ?? 1), 0) || sorted.length;
  const at = (q: number) => {
    let acc = 0;
    for (const d of sorted) {
      acc += Math.max(0, d.weight ?? 1);
      if (acc / total >= q) return d.delta;
    }
    return sorted[sorted.length - 1].delta;
  };
  const median = at(0.5);
  const sign = Math.sign(median);
  const agree = sorted.filter(d => Math.sign(d.delta) === sign && sign !== 0).length / sorted.length;
  return { median, q10: at(0.1), q90: at(0.9), agreement: agree };
}

// Probability primitives. Everything that averages or transforms beliefs does
// so in log-odds space, where evidence is additive.

export const EPS = 1e-4;

export function clampProb(p: number, eps = EPS): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1 - eps, Math.max(eps, p));
}

export function logit(p: number): number {
  const q = clampProb(p);
  return Math.log(q / (1 - q));
}

export function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

/** Brier score for a binary outcome y ∈ {0,1} (or a soft outcome in [0,1]). */
export function brier(p: number, y: number): number {
  return (p - y) ** 2;
}

/** Log loss (natural log), clamped so a single miss cannot be infinite. */
export function logLoss(p: number, y: number): number {
  const q = clampProb(p, 1e-6);
  return -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
}

export interface ProbSample {
  p: number;
  y: number;
}

export function meanBrier(samples: ProbSample[]): number {
  if (samples.length === 0) return 0;
  let s = 0;
  for (const { p, y } of samples) s += brier(p, y);
  return s / samples.length;
}

export function meanLogLoss(samples: ProbSample[]): number {
  if (samples.length === 0) return 0;
  let s = 0;
  for (const { p, y } of samples) s += logLoss(p, y);
  return s / samples.length;
}

/** Expected calibration error with equal-width bins. */
export function expectedCalibrationError(samples: ProbSample[], bins = 10): number {
  if (samples.length === 0) return 0;
  const sumP = new Array<number>(bins).fill(0);
  const sumY = new Array<number>(bins).fill(0);
  const count = new Array<number>(bins).fill(0);
  for (const { p, y } of samples) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    sumP[b] += p;
    sumY[b] += y;
    count[b] += 1;
  }
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    if (count[b] === 0) continue;
    ece += (count[b] / samples.length) * Math.abs(sumP[b] / count[b] - sumY[b] / count[b]);
  }
  return ece;
}

/** Exponential moving average helper for rolling fitness stats. */
export function ema(prev: number, x: number, n: number, halfLife = 30): number {
  if (n <= 0 || !Number.isFinite(prev)) return x;
  const alpha = Math.max(1 / (n + 1), 1 - Math.pow(0.5, 1 / halfLife));
  return prev + alpha * (x - prev);
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/** Weighted quantile (weights need not sum to 1). */
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  if (values.length === 0) return 0;
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return values[idx[Math.floor(q * (idx.length - 1))]];
  let acc = 0;
  for (const i of idx) {
    acc += Math.max(0, weights[i]);
    if (acc / total >= q) return values[i];
  }
  return values[idx[idx.length - 1]];
}

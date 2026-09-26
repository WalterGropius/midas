// Local fallback forecaster, used when the Modal TimesFM service is not
// configured or is down. A driftless random walk in log-odds with EWMA
// volatility — the honest baseline any fancier model must beat.
import { clampProb, logit, sigmoid } from './prob';

export interface PathForecast {
  point: number[];
  q10: number[];
  q90: number[];
  model: string;
}

const Z90 = 1.2815515655446004;

export function ewmaLogitVol(closes: number[], lambda = 0.94): number {
  if (closes.length < 3) return 0.05;
  let v = 0;
  let init = false;
  for (let i = 1; i < closes.length; i++) {
    const r = logit(closes[i]) - logit(closes[i - 1]);
    if (!init) {
      v = r * r;
      init = true;
    } else v = lambda * v + (1 - lambda) * r * r;
  }
  return Math.max(0.005, Math.sqrt(v));
}

export function randomWalkForecast(closes: number[], horizon: number): PathForecast {
  const last = clampProb(closes[closes.length - 1] ?? 0.5);
  const sigma = ewmaLogitVol(closes);
  const l0 = logit(last);
  const point: number[] = [];
  const q10: number[] = [];
  const q90: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    const s = sigma * Math.sqrt(h);
    point.push(last);
    q10.push(sigmoid(l0 - Z90 * s));
    q90.push(sigmoid(l0 + Z90 * s));
  }
  return { point, q10, q90, model: 'logit-random-walk' };
}

/** Pinball loss of a quantile forecast; lower is better. */
export function pinball(y: number, q: number, tau: number): number {
  const d = y - q;
  return d >= 0 ? tau * d : (tau - 1) * d;
}

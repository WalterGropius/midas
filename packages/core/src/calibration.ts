// Calibration: turn raw model probabilities into honest ones.
//
// Platt scaling in log-odds space: p' = σ(a·logit(p) + b). a > 1 extremizes an
// underconfident source, a < 1 tempers an overconfident one (System-1 decision
// models ship overconfident). A Gaussian prior around (a=1, b=0) keeps the fit
// sane when there are only a handful of resolved samples.
import {
  expectedCalibrationError,
  logit,
  meanBrier,
  sigmoid,
  type ProbSample,
} from './prob';

export interface Platt {
  a: number;
  b: number;
  n: number;
}

export const IDENTITY_PLATT: Platt = { a: 1, b: 0, n: 0 };

export function applyPlatt(p: number, cal: Pick<Platt, 'a' | 'b'> | undefined): number {
  if (!cal) return p;
  return sigmoid(cal.a * logit(p) + cal.b);
}

export interface FitOptions {
  /** prior strength (pseudo-observations) pulling toward a=1, b=0 */
  priorStrength?: number;
  iterations?: number;
  /** fix b = 0 (pure temperature scaling) */
  temperatureOnly?: boolean;
}

/** Newton–Raphson MAP fit of logistic regression y ~ σ(a·x + b), x = logit(p). */
export function fitPlatt(samples: ProbSample[], opts: FitOptions = {}): Platt {
  const n = samples.length;
  if (n < 5) return { ...IDENTITY_PLATT, n };
  const lambda = opts.priorStrength ?? 4;
  const iters = opts.iterations ?? 50;
  let a = 1;
  let b = 0;
  const xs = samples.map(s => logit(s.p));
  for (let it = 0; it < iters; it++) {
    // gradient and Hessian of the negative log posterior
    let ga = lambda * (a - 1);
    let gb = opts.temperatureOnly ? 0 : lambda * b;
    let haa = lambda;
    let hab = 0;
    let hbb = lambda;
    for (let i = 0; i < n; i++) {
      const x = xs[i];
      const q = sigmoid(a * x + b);
      const r = q - samples[i].y;
      const w = Math.max(1e-9, q * (1 - q));
      ga += r * x;
      haa += w * x * x;
      if (!opts.temperatureOnly) {
        gb += r;
        hab += w * x;
        hbb += w;
      }
    }
    let da: number;
    let db: number;
    if (opts.temperatureOnly) {
      da = ga / haa;
      db = 0;
    } else {
      const det = haa * hbb - hab * hab;
      if (Math.abs(det) < 1e-12) break;
      da = (hbb * ga - hab * gb) / det;
      db = (haa * gb - hab * ga) / det;
    }
    a -= da;
    b -= db;
    a = Math.min(5, Math.max(0.05, a));
    b = Math.min(5, Math.max(-5, b));
    if (Math.abs(da) + Math.abs(db) < 1e-8) break;
  }
  return { a, b, n };
}

export interface CalibrationReport extends Platt {
  eceBefore: number;
  eceAfter: number;
  brierBefore: number;
  brierAfter: number;
}

export function calibrate(samples: ProbSample[], opts: FitOptions = {}): CalibrationReport {
  const fit = fitPlatt(samples, opts);
  const after = samples.map(s => ({ p: applyPlatt(s.p, fit), y: s.y }));
  return {
    ...fit,
    eceBefore: expectedCalibrationError(samples),
    eceAfter: expectedCalibrationError(after),
    brierBefore: meanBrier(samples),
    brierAfter: meanBrier(after),
  };
}

/** Pool-adjacent-violators isotonic regression; returns a monotone mapper. */
export function fitIsotonic(samples: ProbSample[]): (p: number) => number {
  if (samples.length === 0) return p => p;
  const sorted = [...samples].sort((x, y) => x.p - y.p);
  const blocks: { lo: number; hi: number; sum: number; w: number }[] = [];
  for (const s of sorted) {
    blocks.push({ lo: s.p, hi: s.p, sum: s.y, w: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.w <= last.sum / last.w) break;
      blocks.splice(blocks.length - 2, 2, {
        lo: prev.lo,
        hi: last.hi,
        sum: prev.sum + last.sum,
        w: prev.w + last.w,
      });
    }
  }
  return (p: number) => {
    for (const b of blocks) if (p <= b.hi) return b.sum / b.w;
    const last = blocks[blocks.length - 1];
    return last.sum / last.w;
  };
}

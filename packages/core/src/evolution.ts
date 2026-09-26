// Self-evolution primitives.
//
// The ratchet: propose a mutation, evaluate on held-out cases, KEEP only if it
// beats the parent by more than noise, otherwise REVERT. Parents are drawn from
// the Pareto front over per-case wins (GEPA-style), not from a single
// leaderboard, so specialists that are best on some slice of the world survive.
import type { Rng } from './rng';

export interface Candidate {
  id: string;
  /** loss per evaluation case (lower is better); same case order for everyone */
  caseLosses: number[];
}

/** Candidates that are strictly best (or tied best) on at least one case. */
export function paretoFront(cands: Candidate[]): { id: string; wins: number }[] {
  if (cands.length === 0) return [];
  const nCases = Math.max(...cands.map(c => c.caseLosses.length));
  const wins = new Map<string, number>();
  for (let j = 0; j < nCases; j++) {
    let best = Infinity;
    for (const c of cands) if (c.caseLosses[j] !== undefined) best = Math.min(best, c.caseLosses[j]);
    for (const c of cands) {
      if (c.caseLosses[j] !== undefined && c.caseLosses[j] <= best + 1e-12) wins.set(c.id, (wins.get(c.id) ?? 0) + 1);
    }
  }
  // drop candidates dominated on every case they share with another candidate
  const front = cands.filter(c => (wins.get(c.id) ?? 0) > 0 && !cands.some(o => o !== c && dominates(o, c)));
  return front.map(c => ({ id: c.id, wins: wins.get(c.id) ?? 0 }));
}

function dominates(a: Candidate, b: Candidate): boolean {
  let strictly = false;
  const n = Math.min(a.caseLosses.length, b.caseLosses.length);
  if (n === 0) return false;
  for (let j = 0; j < n; j++) {
    if (a.caseLosses[j] > b.caseLosses[j] + 1e-12) return false;
    if (a.caseLosses[j] < b.caseLosses[j] - 1e-12) strictly = true;
  }
  return strictly;
}

/** Sample a parent from the Pareto front proportionally to its case wins. */
export function sampleParent(rng: Rng, cands: Candidate[]): string | undefined {
  const front = paretoFront(cands);
  const total = front.reduce((s, f) => s + f.wins, 0);
  if (total === 0) return undefined;
  let r = rng() * total;
  for (const f of front) {
    r -= f.wins;
    if (r <= 0) return f.id;
  }
  return front[front.length - 1].id;
}

export interface RatchetResult {
  keep: boolean;
  meanImprovement: number;
  /** bootstrap probability that the child is truly better */
  pBetter: number;
  n: number;
  reason: string;
}

/**
 * Paired bootstrap acceptance test. parent/child losses are per shared case.
 * Keep the child only if it improves the mean loss by at least minImprovement
 * AND is better with probability ≥ confidence. Noisy fitness is the enemy of
 * self-improvement; this is the guard against drifting on luck.
 */
export function ratchetAccept(
  parentLosses: number[],
  childLosses: number[],
  rng: Rng,
  opts: { minImprovement?: number; confidence?: number; minN?: number; resamples?: number } = {}
): RatchetResult {
  const n = Math.min(parentLosses.length, childLosses.length);
  const minN = opts.minN ?? 12;
  if (n < minN) return { keep: false, meanImprovement: 0, pBetter: 0, n, reason: `need ≥${minN} paired cases` };
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) diffs.push(parentLosses[i] - childLosses[i]); // >0 = child better
  const mean = diffs.reduce((s, d) => s + d, 0) / n;
  const B = opts.resamples ?? 1000;
  let better = 0;
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rng() * n)];
    if (s / n > 0) better++;
  }
  const pBetter = better / B;
  const minImp = opts.minImprovement ?? 0;
  const conf = opts.confidence ?? 0.9;
  const keep = mean > minImp && pBetter >= conf;
  return {
    keep,
    meanImprovement: mean,
    pBetter,
    n,
    reason: keep ? 'improved' : mean <= minImp ? 'no mean improvement' : `not confident (p=${pBetter.toFixed(2)})`,
  };
}

/** Diversity-preserving retirement: never retire the last member of a niche. */
export function chooseRetirements(
  agents: { id: string; niche: string; score: number; nScored: number }[],
  maxActive: number,
  minScored = 20
): string[] {
  if (agents.length <= maxActive) return [];
  const byNiche = new Map<string, number>();
  for (const a of agents) byNiche.set(a.niche, (byNiche.get(a.niche) ?? 0) + 1);
  const eligible = agents.filter(a => a.nScored >= minScored).sort((a, b) => b.score - a.score); // worst (highest loss) first
  const out: string[] = [];
  for (const a of eligible) {
    if (agents.length - out.length <= maxActive) break;
    if ((byNiche.get(a.niche) ?? 0) <= 1) continue;
    byNiche.set(a.niche, (byNiche.get(a.niche) ?? 0) - 1);
    out.push(a.id);
  }
  return out;
}

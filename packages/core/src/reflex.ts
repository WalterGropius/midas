// System-1 reflexes.
//
// A reflex is one typed question answered by a fast decision model (Jev,
// Laya, a Flash fallback, or a heuristic) in tens to hundreds of
// milliseconds, in parallel across every (headline × market), (position ×
// tick), (entity × entity) pair. Its *definition* — instructions, criteria,
// threshold — is not fixed: a slow System-2 coach (Gemini Pro) rewrites it
// from logged hits and misses, and a ratchet keeps only rewrites that replay
// better. Fast reactions, slowly tuned by experience.
import { applyPlatt, type Platt } from './calibration';
import { clampProb } from './prob';
import { keywordHits, regexUrgency, tokens } from './text';

export type QType = 'noul' | 'choice' | 'score';

export interface ReflexDef {
  key: string;
  qtype: QType;
  instructions: string;
  criteriaKeys: string[];
  criteriaText: string[];
  threshold: number;
  provider: string;
  version: number;
  enabled: boolean;
  /** for choice reflexes: the key whose probability counts as "fire" */
  positiveKey?: string;
}

export type S1Question =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface S1Answer {
  /** P(true) for noul */
  noul?: number;
  /** chosen key for choice */
  choice?: string;
  /** per-option probabilities for choice */
  probs?: Record<string, number>;
  /** ordinal level (0..levels-1, may be fractional) for score */
  score?: number;
  confidence: number;
  provider: string;
  latencyMs?: number;
}

/** What a reflex looks at: text for the model, features for heuristics. */
export interface ReflexState {
  text: string;
  features?: Record<string, number | string | string[]>;
}

export function toQuestion(def: ReflexDef): S1Question {
  if (def.qtype === 'noul') return { type: 'noul', instructions: def.instructions };
  if (def.qtype === 'choice') {
    const criteria: Record<string, string> = {};
    def.criteriaKeys.forEach((k, i) => (criteria[k] = def.criteriaText[i] ?? k));
    return { type: 'choice', instructions: def.instructions, criteria };
  }
  return { type: 'score', instructions: def.instructions, criteria: def.criteriaText };
}

/** Collapse any answer to the probability that the reflex should fire. */
export function reflexProb(def: ReflexDef, ans: S1Answer): number {
  if (def.qtype === 'noul') return clampProb(ans.noul ?? 0.5, 1e-4);
  if (def.qtype === 'choice') {
    const key = def.positiveKey ?? def.criteriaKeys[0];
    if (ans.probs && key in ans.probs) return clampProb(ans.probs[key], 1e-4);
    return ans.choice === key ? clampProb(ans.confidence, 1e-4) : clampProb(1 - ans.confidence, 1e-4);
  }
  const levels = Math.max(2, def.criteriaText.length);
  return clampProb((ans.score ?? 0) / (levels - 1), 1e-4);
}

export interface ReflexVerdict {
  fire: boolean;
  prob: number;
  rawProb: number;
}

export function evaluateReflex(def: ReflexDef, ans: S1Answer, cal?: Pick<Platt, 'a' | 'b'>): ReflexVerdict {
  const raw = reflexProb(def, ans);
  const prob = applyPlatt(raw, cal);
  return { fire: def.enabled && prob >= def.threshold, prob, rawProb: raw };
}

export interface Utility {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/**
 * Pick the firing threshold that maximizes realized utility on resolved
 * samples. This is the numeric half of the coach; the LLM half rewrites the
 * question itself.
 */
export function tuneThreshold(
  samples: { p: number; y: number }[],
  u: Utility,
  grid = 19
): { threshold: number; utility: number; baseline: number } {
  const utilAt = (th: number) =>
    samples.reduce((s, { p, y }) => {
      const fire = p >= th;
      if (fire && y >= 0.5) return s + u.tp;
      if (fire) return s + u.fp;
      if (y >= 0.5) return s + u.fn;
      return s + u.tn;
    }, 0);
  let best = { threshold: 0.5, utility: utilAt(0.5) };
  for (let i = 1; i <= grid; i++) {
    const th = i / (grid + 1);
    const v = utilAt(th);
    if (v > best.utility) best = { threshold: th, utility: v };
  }
  return { ...best, baseline: utilAt(0.5) };
}

// ───────────────────────────── default reflex set ─────────────────────────────

const d = (
  key: string,
  qtype: QType,
  instructions: string,
  threshold: number,
  criteria: [string, string][] = [],
  positiveKey?: string
): ReflexDef => ({
  key,
  qtype,
  instructions,
  criteriaKeys: criteria.map(c => c[0]),
  criteriaText: criteria.map(c => c[1]),
  threshold,
  provider: 'auto',
  version: 1,
  enabled: true,
  positiveKey,
});

/** Where System 1 sits in the loop. Every one of these is coach-tunable. */
export const DEFAULT_REFLEXES: ReflexDef[] = [
  d(
    'news.relevance',
    'noul',
    'Could this news item plausibly move the probability of the prediction market described below within the next few hours? Answer true only if the news is about the same event, actors, or a direct cause of the outcome.',
    0.35
  ),
  d(
    'news.direction',
    'choice',
    'If traders react to this news, in which direction does the price of the YES outcome of the market below move?',
    0.6,
    [
      ['up', 'the news makes the YES outcome more likely'],
      ['down', 'the news makes the YES outcome less likely'],
      ['none', 'no meaningful effect on the YES outcome'],
    ],
    'up'
  ),
  d(
    'news.urgency',
    'score',
    'How quickly and strongly will a prediction market on this topic react to this news?',
    0.5,
    [
      ['0', 'background: no reaction expected'],
      ['1', 'minor: small drift over hours'],
      ['2', 'material: clear repricing within the hour'],
      ['3', 'decisive: immediate large repricing (resolution-relevant fact)'],
    ]
  ),
  d(
    'news.novelty',
    'noul',
    'Does the NEW headline contain information that is not already in the RECENT headlines listed? A rewording, recap, or follow-up without new facts is not new.',
    0.5
  ),
  d(
    'route.escalate',
    'noul',
    'Given the market, the news, and the fast forecasters\' answers shown below, is a slower, deeper analysis likely to change the trading decision (because the forecasters disagree, the stakes are high, or the reasoning looks shallow)?',
    0.5
  ),
  d(
    'position.exit',
    'noul',
    'Should this open prediction-market position be closed now? Consider whether the expected move has already happened, the time elapsed versus the expected reaction time, and any new contradicting news.',
    0.6
  ),
  d(
    'entity.same',
    'noul',
    'Do the two names below refer to the same real-world entity (same person, organization, place, asset, or event)?',
    0.8
  ),
  d(
    'claim.grounded',
    'noul',
    'Is every factual claim in the RATIONALE supported by the EVIDENCE provided? Answer false if the rationale introduces facts, numbers, or events that are not in the evidence.',
    0.55
  ),
  d(
    'wiki.stale',
    'noul',
    'Is the wiki PAGE below contradicted by, or made outdated by, the NEW FACTS listed after it?',
    0.6
  ),
];

// ───────────────────────────── heuristic fallback ─────────────────────────────

function num(f: ReflexState['features'], k: string, dflt = 0): number {
  const v = f?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function strs(f: ReflexState['features'], k: string): string[] {
  const v = f?.[k];
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}

function overlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

/**
 * Model-free answers, used when no decision-model provider is configured and
 * in tests. Deliberately conservative: they fire less than a real model.
 */
export function heuristicAnswer(def: ReflexDef, state: ReflexState): S1Answer {
  const f = state.features;
  const provider = 'heuristic';
  switch (def.key) {
    case 'news.relevance': {
      const headline = String(f?.headline ?? state.text);
      const question = String(f?.question ?? '');
      const kw = keywordHits(headline, strs(f, 'keywords')).length;
      const p = Math.min(0.95, 0.05 + 0.9 * overlap(headline, question) + 0.25 * Math.min(2, kw));
      return { noul: p, confidence: Math.max(p, 1 - p), provider };
    }
    case 'news.urgency': {
      const u = regexUrgency(String(f?.headline ?? state.text));
      return { score: u * 3, confidence: 0.5, provider };
    }
    case 'news.direction':
      return { choice: 'none', probs: { up: 0.2, down: 0.2, none: 0.6 }, confidence: 0.6, provider };
    case 'news.novelty': {
      const recent = strs(f, 'recent');
      const headline = String(f?.headline ?? state.text);
      const maxSim = recent.reduce((m, r) => Math.max(m, overlap(headline, r)), 0);
      const p = 1 - maxSim;
      return { noul: p, confidence: Math.max(p, 1 - p), provider };
    }
    case 'route.escalate': {
      const dis = num(f, 'disagreement');
      const edge = Math.abs(num(f, 'edge'));
      const p = Math.min(0.95, 0.1 + dis * 0.6 + edge * 3);
      return { noul: p, confidence: 0.5, provider };
    }
    case 'position.exit': {
      const remaining = num(f, 'remainingMoveFrac', 1);
      const pnlPct = num(f, 'pnlPct');
      const p = Math.min(0.95, Math.max(0.05, 0.9 - remaining + (pnlPct < -0.15 ? 0.3 : 0)));
      return { noul: p, confidence: 0.5, provider };
    }
    case 'entity.same': {
      const a = String(f?.a ?? '');
      const b = String(f?.b ?? '');
      const p = a.toLowerCase() === b.toLowerCase() ? 0.98 : overlap(a, b) > 0.8 ? 0.7 : 0.05;
      return { noul: p, confidence: Math.max(p, 1 - p), provider };
    }
    default:
      return { noul: 0.5, confidence: 0.5, provider };
  }
}

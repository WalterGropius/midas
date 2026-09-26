import { describe, expect, it } from 'vitest';
import {
  aggregateForecasts,
  aggregateDeltas,
  analogReactionPrior,
  applyPlatt,
  blendWithMarket,
  buildAdjacency,
  buildSeedFiles,
  calibrate,
  chooseRetirements,
  circuitBreaker,
  deltaFromShift,
  DEFAULT_REFLEXES,
  DEFAULT_RISK,
  DEFAULT_INTEL,
  evaluateReflex,
  expectedPriceAt,
  fitIsotonic,
  hedgeWeights,
  heuristicAnswer,
  hybridRetrieve,
  independentConfirmation,
  isNearDuplicate,
  kellyFraction,
  logit,
  makeFeeFn,
  maxStakeUsd,
  mulberry32,
  newsHash,
  nodeKey,
  overlayShock,
  paretoFront,
  parseSeedFiles,
  personalizedPageRank,
  preTradeReasons,
  randomWalkForecast,
  ratchetAccept,
  realizedDelta,
  regexUrgency,
  remainingFraction,
  scoreReaction,
  sigmoid,
  sizePosition,
  tuneThreshold,
  walkBook,
  type GEdge,
  type GNode,
} from '../src';

describe('prob + aggregation', () => {
  it('logit/sigmoid round-trip', () => {
    for (const p of [0.01, 0.2, 0.5, 0.77, 0.99]) expect(sigmoid(logit(p))).toBeCloseTo(p, 6);
  });

  it('aggregates in log-odds, trims outliers, extremizes', () => {
    const agg = aggregateForecasts(
      [{ prob: 0.7 }, { prob: 0.72 }, { prob: 0.68 }, { prob: 0.71 }, { prob: 0.02 }],
      { trim: 0.2, extremize: 1 }
    );
    // the 0.02 outlier is trimmed away
    expect(agg.prob).toBeGreaterThan(0.65);
    expect(agg.prob).toBeLessThan(0.75);
    const ext = aggregateForecasts([{ prob: 0.7 }, { prob: 0.7 }], { trim: 0, extremize: 2 });
    expect(ext.prob).toBeGreaterThan(0.8);
    expect(agg.disagreement).toBeGreaterThan(0.5);
  });

  it('blends with the market in log-odds', () => {
    expect(blendWithMarket(0.9, 0.5, 0)).toBeCloseTo(0.5, 6);
    expect(blendWithMarket(0.9, 0.5, 1)).toBeCloseTo(0.9, 6);
    const mid = blendWithMarket(0.9, 0.5, 0.5);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(0.9);
  });

  it('hedge weights favour low loss and sum to 1', () => {
    const w = hedgeWeights([1, 2, 5]);
    expect(w[0]).toBeGreaterThan(w[1]);
    expect(w[1]).toBeGreaterThan(w[2]);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('independent confirmation compounds', () => {
    expect(independentConfirmation([0.5])).toBeCloseTo(0.5);
    expect(independentConfirmation([0.5, 0.5, 0.5])).toBeCloseTo(0.875);
  });

  it('aggregates reaction deltas with agreement', () => {
    const r = aggregateDeltas([{ delta: 0.05 }, { delta: 0.04 }, { delta: 0.06 }, { delta: -0.01 }]);
    expect(r.median).toBeGreaterThan(0.03);
    expect(r.agreement).toBeCloseTo(0.75);
  });
});

describe('calibration', () => {
  it('Platt fit tempers an overconfident source', () => {
    const rng = mulberry32(7);
    const samples = [];
    for (let i = 0; i < 2000; i++) {
      const trueP = rng();
      const y = rng() < trueP ? 1 : 0;
      // overconfident reports: push log-odds out by 2.5x
      const reported = sigmoid(2.5 * logit(trueP));
      samples.push({ p: reported, y });
    }
    const rep = calibrate(samples, { priorStrength: 1 });
    expect(rep.a).toBeLessThan(0.6);
    expect(rep.a).toBeGreaterThan(0.25);
    expect(rep.eceAfter).toBeLessThan(rep.eceBefore);
    expect(rep.brierAfter).toBeLessThanOrEqual(rep.brierBefore + 1e-9);
    expect(applyPlatt(0.95, rep)).toBeLessThan(0.95);
  });

  it('prior keeps tiny samples near identity', () => {
    const rep = calibrate([
      { p: 0.9, y: 0 },
      { p: 0.9, y: 0 },
      { p: 0.9, y: 1 },
      { p: 0.1, y: 0 },
      { p: 0.2, y: 1 },
    ]);
    expect(Math.abs(rep.a - 1)).toBeLessThan(0.8);
  });

  it('isotonic is monotone', () => {
    const f = fitIsotonic([
      { p: 0.1, y: 0 },
      { p: 0.2, y: 1 },
      { p: 0.3, y: 0 },
      { p: 0.8, y: 1 },
      { p: 0.9, y: 1 },
    ]);
    expect(f(0.1)).toBeLessThanOrEqual(f(0.3));
    expect(f(0.3)).toBeLessThanOrEqual(f(0.9));
  });
});

describe('kelly + book walking', () => {
  it('kelly fraction for a binary share', () => {
    expect(kellyFraction(0.6, 0.5)).toBeCloseTo(0.2);
    expect(kellyFraction(0.4, 0.5)).toBe(0);
  });

  it('walks the book and pays fees', () => {
    const asks = [
      { price: 0.52, size: 100 },
      { price: 0.55, size: 100 },
    ];
    const fill = walkBook(asks, 80);
    expect(fill.levelsUsed).toBe(2);
    expect(fill.avgPrice).toBeGreaterThan(0.52);
    expect(fill.costUsd).toBeCloseTo(80, 6);
    const withFee = walkBook(asks, 80, makeFeeFn(0.02, 'pq'));
    expect(withFee.shares).toBeLessThan(fill.shares);
  });

  it('sizes fractional Kelly and respects min edge and caps', () => {
    const asks = [
      { price: 0.5, size: 50 },
      { price: 0.56, size: 1000 },
      { price: 0.7, size: 1000 },
    ];
    const s = sizePosition({
      p: 0.62,
      asks,
      equityUsd: 1000,
      cashUsd: 1000,
      kellyMultiplier: 0.25,
      maxStakeUsd: 60,
      minEdge: 0.03,
    });
    expect(s.reason).toBe('ok');
    expect(s.stakeUsd).toBeLessThanOrEqual(60 + 1e-9);
    expect(s.worstPrice).toBeLessThanOrEqual(0.59);
    expect(s.edgeAtAvg).toBeGreaterThanOrEqual(0.03);
    const none = sizePosition({ ...s, p: 0.51, asks, equityUsd: 1000, cashUsd: 1000, kellyMultiplier: 0.25, maxStakeUsd: 60, minEdge: 0.03 });
    expect(none.shares).toBe(0);
  });
});

describe('risk', () => {
  const acct = {
    equityUsd: 900,
    cashUsd: 500,
    peakEquityUsd: 1000,
    dayStartEquityUsd: 1000,
    exposureUsd: 400,
    openPositions: 3,
    exposureInMarketUsd: 50,
  };
  it('trips breakers', () => {
    expect(circuitBreaker(acct, { ...DEFAULT_RISK, maxDailyLossPct: 0.05 })).toBe('daily_loss');
    expect(circuitBreaker(acct, { ...DEFAULT_RISK, maxDrawdownPct: 0.1 })).toBe('drawdown');
    expect(circuitBreaker(acct, DEFAULT_RISK)).toBe('daily_loss');
  });
  it('computes the binding stake limit', () => {
    const m = maxStakeUsd(acct, { ...DEFAULT_RISK, maxPositionPct: 0.1, maxGrossExposurePct: 0.6 });
    expect(m.usd).toBeCloseTo(40); // 10% of 900 − 50
    expect(m.binding).toBe('max position');
  });
  it('lists pre-trade blockers', () => {
    const r = preTradeReasons(acct, { ...DEFAULT_RISK, maxDailyLossPct: 0.5, maxDrawdownPct: 0.5 }, {
      marketActive: true,
      priceAgeSec: 200,
      spread: 0.2,
      haltAll: false,
      sessionRunning: true,
      isNewPosition: true,
    });
    expect(r.some(x => x.includes('stale'))).toBe(true);
    expect(r.some(x => x.includes('spread'))).toBe(true);
  });
});

describe('graph memory', () => {
  const now = Date.UTC(2026, 8, 26);
  const node = (id: string, kind: string, label: string, mentions = 1, emb?: number[]): GNode => ({
    id,
    key: nodeKey(kind, label),
    kind,
    label,
    salience: 1,
    mentionCount: mentions,
    status: 'canonical',
    updatedAtMs: now,
    embedding: emb,
  });
  const nodes = [
    node('fed', 'entity', 'Federal Reserve', 50),
    node('powell', 'entity', 'Jerome Powell', 10),
    node('m1', 'market', 'Fed cuts in December?', 1),
    node('e1', 'event', 'Powell signals patience', 1, [1, 0, 0]),
    node('e2', 'event', 'Unrelated sports result', 1, [0, 1, 0]),
    node('l1', 'lesson', 'Fed-speak moves rate markets within 30 minutes', 1),
  ];
  const edge = (src: string, dst: string, rel: string, ageDays = 0, invalidated = false): GEdge => ({
    src,
    dst,
    rel,
    weight: 1,
    createdAtMs: now - ageDays * 86_400_000,
    invalidated,
  });
  const edges = [
    edge('e1', 'powell', 'mentions'),
    edge('powell', 'fed', 'related'),
    edge('e1', 'm1', 'moved'),
    edge('l1', 'm1', 'lesson_for'),
    edge('e2', 'fed', 'mentions', 0, true),
  ];
  const adj = buildAdjacency(nodes, edges, { nowMs: now });

  it('PPR concentrates mass near the seeds and ignores invalidated edges', () => {
    const pr = personalizedPageRank(adj, new Map([['powell', 1]]));
    expect(pr.get('e1')! > (pr.get('e2') ?? 0)).toBe(true);
    expect(pr.get('e2') ?? 0).toBe(0);
    const total = [...pr.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('hybrid retrieval surfaces the market, the analog event and the lesson', () => {
    const got = hybridRetrieve(adj, ['powell'], { nowMs: now, queryEmbedding: [1, 0, 0], k: 5 });
    const ids = got.map(g => g.node.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('m1');
    expect(ids).toContain('l1');
    expect(ids).not.toContain('e2');
  });

  it('analog prior weights similar, recent reactions', () => {
    const prior = analogReactionPrior([
      { similarity: 0.95, delta: 0.08, ageDays: 3 },
      { similarity: 0.9, delta: 0.06, ageDays: 10 },
      { similarity: 0.6, delta: -0.1, ageDays: 300 },
      { similarity: 0.2, delta: -0.5, ageDays: 1 },
    ]);
    expect(prior.n).toBe(3);
    expect(prior.mean).toBeGreaterThan(0.05);
    expect(prior.effN).toBeGreaterThan(1);
  });

  it('node keys are canonical', () => {
    expect(nodeKey('entity', 'Federal Reserve (Fed)')).toBe('entity:federal-reserve-fed');
    expect(nodeKey('entity', 'Banco de México')).toBe('entity:banco-de-mexico');
  });
});

describe('reaction model', () => {
  it('maps log-odds shifts to price moves that shrink near the edges', () => {
    expect(deltaFromShift(0.5, 0.7)).toBeCloseTo(0.168, 2);
    expect(deltaFromShift(0.95, 0.7)).toBeLessThan(0.03);
    expect(deltaFromShift(0.5, -0.7)).toBeCloseTo(-0.168, 2);
  });

  it('half-life decay', () => {
    expect(remainingFraction(10, 10)).toBeCloseTo(0.5);
    expect(remainingFraction(10, 0)).toBeCloseTo(1);
  });

  it('expected price moves toward target in log-odds', () => {
    const p = expectedPriceAt(0.5, 0.2, 10, 1000);
    expect(p).toBeCloseTo(0.7, 3);
    expect(expectedPriceAt(0.5, 0.2, 10, 10)).toBeGreaterThan(0.55);
  });

  it('overlays a shock on a flat baseline', () => {
    const path = overlayShock([0.4, 0.4, 0.4, 0.4], 300, 0.1, 5, 0);
    expect(path[0]).toBeGreaterThan(0.4);
    expect(path[3]).toBeGreaterThan(path[0]);
    expect(path[3]).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it('measures and scores realized reactions', () => {
    const t0 = 1_000_000;
    const bars = Array.from({ length: 40 }, (_, i) => ({ tsMs: t0 + i * 60_000, close: i < 2 ? 0.4 : 0.47 }));
    const d = realizedDelta(bars, t0 + 60_000, 30);
    expect(d).toBeCloseTo(0.07, 6);
    expect(realizedDelta(bars, t0, 120)).toBeUndefined();
    const s = scoreReaction({ delta: 0.05, q10: 0.01, q90: 0.09 }, 0.07);
    expect(s.directionHit).toBe(1);
    expect(s.covered).toBe(true);
  });

  it('random-walk fallback widens with horizon', () => {
    const f = randomWalkForecast([0.4, 0.42, 0.41, 0.43, 0.44, 0.43], 10);
    expect(f.q90[9] - f.q10[9]).toBeGreaterThan(f.q90[0] - f.q10[0]);
  });
});

describe('text triage', () => {
  it('hashes stably and detects near duplicates', () => {
    expect(newsHash('Fed Holds Rates - Bloomberg', 'https://x.com/a?utm=1')).toBe(newsHash('fed holds rates', 'https://x.com/a'));
    expect(
      isNearDuplicate(
        'Fed holds rates steady as Powell signals patience on cuts',
        'Fed holds rates steady as Powell signals patience on rate cuts'
      )
    ).toBe(true);
    expect(isNearDuplicate('Fed holds rates steady', 'Lakers beat Celtics in overtime thriller')).toBe(false);
  });
  it('regex urgency', () => {
    expect(regexUrgency('BREAKING: Prime minister resigns')).toBeGreaterThan(0.6);
    expect(regexUrgency('A quiet day for gardening tips')).toBe(0);
  });
});

describe('reflexes', () => {
  const relevance = DEFAULT_REFLEXES.find(r => r.key === 'news.relevance')!;
  it('heuristic relevance separates related from unrelated news', () => {
    const q = 'Will the Fed cut interest rates in December?';
    const rel = heuristicAnswer(relevance, {
      text: '',
      features: { headline: 'Fed officials signal December interest rate cut', question: q },
    });
    const irr = heuristicAnswer(relevance, {
      text: '',
      features: { headline: 'Lakers win in overtime', question: q },
    });
    expect(evaluateReflex(relevance, rel).fire).toBe(true);
    expect(evaluateReflex(relevance, irr).fire).toBe(false);
  });

  it('calibrator moves the firing decision', () => {
    const ans = { noul: 0.4, confidence: 0.6, provider: 'x' };
    expect(evaluateReflex(relevance, ans).fire).toBe(true);
    expect(evaluateReflex(relevance, ans, { a: 1, b: -1 }).fire).toBe(false);
  });

  it('threshold tuning maximizes utility', () => {
    const samples = [
      ...Array.from({ length: 20 }, () => ({ p: 0.8, y: 1 })),
      ...Array.from({ length: 20 }, () => ({ p: 0.3, y: 0 })),
      ...Array.from({ length: 5 }, () => ({ p: 0.3, y: 1 })),
    ];
    const t = tuneThreshold(samples, { tp: 1, fp: -1, fn: -0.2, tn: 0 });
    expect(t.threshold).toBeGreaterThan(0.3);
    expect(t.threshold).toBeLessThanOrEqual(0.8);
  });
});

describe('evolution ratchet', () => {
  it('pareto front keeps specialists', () => {
    const front = paretoFront([
      { id: 'generalist', caseLosses: [0.2, 0.2, 0.2] },
      { id: 'specialist', caseLosses: [0.05, 0.4, 0.4] },
      { id: 'dominated', caseLosses: [0.3, 0.3, 0.3] },
    ]);
    const ids = front.map(f => f.id);
    expect(ids).toContain('generalist');
    expect(ids).toContain('specialist');
    expect(ids).not.toContain('dominated');
  });

  it('keeps real improvements and rejects noise', () => {
    const rng = mulberry32(1);
    const parent = Array.from({ length: 60 }, () => 0.25 + (rng() - 0.5) * 0.1);
    const better = parent.map(x => x - 0.03 + (rng() - 0.5) * 0.02);
    const noise = parent.map(x => x + (rng() - 0.5) * 0.1);
    expect(ratchetAccept(parent, better, mulberry32(2)).keep).toBe(true);
    expect(ratchetAccept(parent, noise, mulberry32(3), { minImprovement: 0.005 }).keep).toBe(false);
    expect(ratchetAccept(parent.slice(0, 5), better.slice(0, 5), mulberry32(4)).keep).toBe(false);
  });

  it('never retires the last agent of a niche', () => {
    const out = chooseRetirements(
      [
        { id: 'a', niche: 'politics', score: 0.3, nScored: 50 },
        { id: 'b', niche: 'politics', score: 0.2, nScored: 50 },
        { id: 'c', niche: 'crypto', score: 0.9, nScored: 50 },
      ],
      2
    );
    expect(out).toEqual(['a']);
  });
});

describe('seed folders', () => {
  it('round-trips config through seed.yaml', () => {
    const files = buildSeedFiles(
      {
        name: 'Fed December',
        mode: 'paper',
        bankrollUsd: 2500,
        markets: [{ conditionId: '0xabc', question: 'Fed cut in December?', prior: 0.4 }],
        risk: DEFAULT_RISK,
        intel: DEFAULT_INTEL,
        feeds: ['bloomberg:markets'],
        keywords: ['Powell', 'FOMC'],
        thesis: 'Labor market is cracking.',
      },
      [{ path: 'notes.md', content: 'my notes' }]
    );
    expect(files.map(f => f.path)).toEqual(
      expect.arrayContaining(['seed.yaml', 'SCHEMA.md', 'thesis.md', 'wiki/index.md', 'wiki/log.md', 'raw/notes.md'])
    );
    const cfg = parseSeedFiles(files);
    expect(cfg.bankrollUsd).toBe(2500);
    expect(cfg.markets[0].prior).toBe(0.4);
    expect(cfg.keywords).toContain('FOMC');
    expect(cfg.thesis).toContain('cracking');
  });
});

describe('point-in-time graph reads', () => {
  it('ignores facts recorded after asOf and honours invalidation time', () => {
    const now = Date.UTC(2026, 8, 26);
    const n = (id: string, createdAtMs = now - 10 * 86_400_000): GNode => ({
      id, key: id, kind: 'entity', label: id, salience: 1, mentionCount: 1, status: 'canonical', updatedAtMs: now, createdAtMs,
    });
    const nodes = [n('a'), n('b'), n('c', now)];
    const edges: GEdge[] = [
      { src: 'a', dst: 'b', rel: 'related', weight: 1, createdAtMs: now - 5 * 86_400_000, invalidated: true, invalidatedAtMs: now - 86_400_000 },
      { src: 'a', dst: 'c', rel: 'related', weight: 1, createdAtMs: now, invalidated: false },
    ];
    const past = buildAdjacency(nodes, edges, { nowMs: now, asOfMs: now - 2 * 86_400_000 });
    expect(past.out.get('a')?.map(e => e.to)).toEqual(['b']);
    expect(past.nodes.has('c')).toBe(false);
    const present = buildAdjacency(nodes, edges, { nowMs: now });
    expect(present.out.get('a')?.map(e => e.to)).toEqual(['c']);
  });
});

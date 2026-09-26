// Live-trading readiness: the research-backed gate between paper and money.
// Real orders stay refused until the paper track record shows the system
// beats the market price on resolved questions, is calibrated, and made money
// after fees with a bootstrap interval above zero.
import { expectedCalibrationError, meanBrier, mulberry32 } from '@midas/core';
import type { Conn } from '../stdb';

export interface Readiness {
  ready: boolean;
  resolved: number;
  brierModel: number;
  brierMarket: number;
  ece: number;
  tradeCount: number;
  meanPnl: number;
  pnlLow: number;
  reasons: string[];
}

export const READINESS_RULES = { minResolved: 300, maxEce: 0.05, minTrades: 50 };

let cache: { at: number; r: Readiness } | undefined;

export function readiness(conn: Conn): Readiness {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.r;
  const byRef = new Map<string, { model?: number; market?: number; y?: number }>();
  for (const s of conn.db.calibrationSample.iter()) {
    if (s.outcome === undefined) continue;
    if (s.component !== 'consensus:resolution' && s.component !== 'market:resolution') continue;
    const e = byRef.get(s.refId) ?? {};
    if (s.component === 'consensus:resolution') e.model = s.prob;
    else e.market = s.prob;
    e.y = s.outcome;
    byRef.set(s.refId, e);
  }
  const paired = [...byRef.values()].filter(e => e.model !== undefined && e.market !== undefined && e.y !== undefined) as {
    model: number;
    market: number;
    y: number;
  }[];
  const brierModel = meanBrier(paired.map(e => ({ p: e.model, y: e.y })));
  const brierMarket = meanBrier(paired.map(e => ({ p: e.market, y: e.y })));
  const ece = expectedCalibrationError(paired.map(e => ({ p: e.model, y: e.y })));

  // per-trade realized PnL on paper sessions (closed positions)
  const pnls: number[] = [];
  for (const p of conn.db.position.iter()) {
    if (!p.closed) continue;
    const s = conn.db.session.id.find(p.sessionId);
    if (s?.mode === 'paper') pnls.push(p.realizedPnlUsd);
  }
  const meanPnl = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const rng = mulberry32(42);
  const boots: number[] = [];
  for (let b = 0; b < 500 && pnls.length > 0; b++) {
    let s = 0;
    for (let i = 0; i < pnls.length; i++) s += pnls[Math.floor(rng() * pnls.length)];
    boots.push(s / pnls.length);
  }
  boots.sort((a, b) => a - b);
  const pnlLow = boots.length ? boots[Math.floor(0.05 * boots.length)] : 0;

  const reasons: string[] = [];
  if (paired.length < READINESS_RULES.minResolved) reasons.push(`${paired.length}/${READINESS_RULES.minResolved} resolved forecasts`);
  if (!(brierModel < brierMarket)) reasons.push(`Brier ${brierModel.toFixed(4)} does not beat market ${brierMarket.toFixed(4)}`);
  if (ece > READINESS_RULES.maxEce) reasons.push(`ECE ${ece.toFixed(3)} > ${READINESS_RULES.maxEce}`);
  if (pnls.length < READINESS_RULES.minTrades) reasons.push(`${pnls.length}/${READINESS_RULES.minTrades} closed paper trades`);
  if (!(pnlLow > 0)) reasons.push('paper PnL 95% interval includes zero');
  const r: Readiness = {
    ready: reasons.length === 0,
    resolved: paired.length,
    brierModel,
    brierMarket,
    ece,
    tradeCount: pnls.length,
    meanPnl,
    pnlLow,
    reasons,
  };
  cache = { at: Date.now(), r };
  return r;
}

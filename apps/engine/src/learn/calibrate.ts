// Periodic calibration: fit a Platt calibrator per probabilistic component
// (every System-1 reflex, the swarm consensus, the Pro supervisor) from its
// resolved samples, and publish reflex quality stats for the coach and UI.
import { calibrate, meanBrier } from '@midas/core';
import type { EngineCtx } from '../ctx';
import { logger } from '../log';
import type { Handler } from '../ledger/types';

const log = logger('calibrate');

export const calibrateAll: Handler = async ctx => {
  const byComponent = new Map<string, { p: number; y: number }[]>();
  for (const s of ctx.conn.db.calibrationSample.iter()) {
    if (s.outcome === undefined) continue;
    const arr = byComponent.get(s.component) ?? [];
    arr.push({ p: s.prob, y: s.outcome });
    byComponent.set(s.component, arr);
  }
  const fitted: string[] = [];
  for (const [component, samples] of byComponent) {
    if (samples.length < 30) continue;
    // keep the most recent 2000: behaviour drifts as agents and reflexes evolve
    const recent = samples.slice(-2000);
    const rep = calibrate(recent, { priorStrength: 4 });
    await ctx.conn.reducers.upsertCalibrator({
      cal: {
        component,
        a: rep.a,
        b: rep.b,
        n: rep.n,
        eceBefore: rep.eceBefore,
        eceAfter: rep.eceAfter,
        brierBefore: rep.brierBefore,
        brierAfter: rep.brierAfter,
      },
    });
    fitted.push(`${component}(n=${rep.n}, ece ${rep.eceBefore.toFixed(3)}→${rep.eceAfter.toFixed(3)})`);
  }
  // reflex quality stats
  const stats = [];
  for (const r of ctx.conn.db.reflex.iter()) {
    const samples = byComponent.get(`reflex:${r.key}`) ?? [];
    if (samples.length === 0) continue;
    const hits = samples.filter(s => (s.p >= r.threshold ? 1 : 0) === (s.y >= 0.5 ? 1 : 0)).length;
    stats.push({
      key: r.key,
      firedDelta: 0,
      nResolved: samples.length,
      brier: meanBrier(samples),
      hitRate: hits / samples.length,
      avgLatencyMs: r.avgLatencyMs,
    });
  }
  if (stats.length) await ctx.conn.reducers.recordReflexStats({ stats });
  if (fitted.length) log.info('fitted', { components: fitted.join(' ') });
  return { result: { fitted } };
};

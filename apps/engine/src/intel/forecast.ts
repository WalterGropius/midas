// Price-path forecasts: TimesFM 2.5 on Modal (or the local log-odds random
// walk when the service is not configured), then the unabsorbed part of recent
// news shocks is overlaid. TimesFM is a baseline and volatility band, not a
// signal: the decision layer only uses its direction as a weak confirmation.
import { overlayShock, randomWalkForecast } from '@midas/core';
import { config } from '../config';
import type { EngineCtx } from '../ctx';
import { logger } from '../log';
import { fetchJson } from '../util/async';
import { msFromTs, tsFromMs } from '../util/time';
import type { Handler } from '../ledger/types';

const log = logger('forecast');

interface ModalForecast {
  id: string;
  point: number[];
  q10: number[];
  q90: number[];
  model: string;
}

/** Resample 1-minute closes to a `stepSec` grid (last value per bucket, forward-filled). */
function resample(bars: { tsMs: number; close: number }[], stepSec: number, maxPoints: number): number[] {
  if (bars.length === 0) return [];
  const step = stepSec * 1000;
  const start = Math.floor(bars[0].tsMs / step) * step;
  const end = Math.floor(bars[bars.length - 1].tsMs / step) * step;
  const out: number[] = [];
  let j = 0;
  let last = bars[0].close;
  for (let t = start; t <= end; t += step) {
    while (j < bars.length && bars[j].tsMs < t + step) last = bars[j++].close;
    out.push(last);
  }
  return out.slice(-maxPoints);
}

export const forecastPaths: Handler = async ctx => {
  const stepSec = config.loops.forecastStepSec;
  const horizon = config.loops.forecastHorizonSteps;
  const series: { id: string; values: number[]; step_sec: number }[] = [];
  for (const cid of ctx.hub.watched()) {
    const m = ctx.hub.market(cid);
    if (!m || !m.active) continue;
    const values = resample(ctx.hub.bars1m(cid, Date.now() - 2 * 86_400_000), stepSec, 512);
    if (values.length >= 16) series.push({ id: cid, values, step_sec: stepSec });
  }
  if (series.length === 0) return { result: { skipped: 'no market has enough history' } };

  let results: ModalForecast[] = [];
  if (config.modal.url) {
    try {
      const res = await fetchJson<{ forecasts: ModalForecast[] }>(`${config.modal.url.replace(/\/+$/, '')}/forecast`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.modal.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ series, horizon, quantiles: [0.1, 0.5, 0.9], space: 'logit' }),
        timeoutMs: config.modal.timeoutMs,
      });
      results = res.forecasts ?? [];
    } catch (err) {
      log.warn('TimesFM service failed; using local fallback', { err: String(err) });
    }
  }
  const byId = new Map(results.map(r => [r.id, r]));
  let written = 0;
  for (const s of series) {
    const f = byId.get(s.id) ?? { id: s.id, ...randomWalkForecast(s.values, horizon) };
    let point = f.point;
    let adjusted = false;
    // overlay the unabsorbed part of fresh news shocks
    for (const sig of ctx.conn.db.signal.conditionId.filter(s.id)) {
      const news = ctx.conn.db.newsItem.id.find(sig.newsId);
      if (!news || sig.layer === 'reflex') continue;
      const elapsedMin = (Date.now() - msFromTs(news.publishedAt)) / 60_000;
      if (elapsedMin > 4 * sig.halfLifeMin + 30) continue;
      point = overlayShock(point, stepSec, sig.expectedDelta, sig.halfLifeMin, elapsedMin);
      adjusted = true;
    }
    await ctx.conn.reducers.insertPathForecast({
      forecast: {
        conditionId: s.id,
        baseTs: tsFromMs(Date.now()),
        stepSec,
        lastPrice: s.values[s.values.length - 1],
        point,
        q10: f.q10,
        q90: f.q90,
        model: f.model,
        newsAdjusted: adjusted,
      },
    });
    written++;
  }
  return { result: { written, model: results[0]?.model ?? 'logit-random-walk' } };
};

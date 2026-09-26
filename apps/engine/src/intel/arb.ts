// Consistency before cleverness: in a multi-outcome (neg-risk) event exactly
// one outcome resolves YES, so buying one YES share of every outcome pays $1.
// If the asks sum (plus taker fees) to less than $1 by a margin, that is
// arbitrage. This scanner detects it for events the sessions watch and
// reports it; execution stays manual until multi-leg fills are handled.
import type { EngineCtx } from '../ctx';
import { config } from '../config';
import { logger } from '../log';
import { fetchJson } from '../util/async';
import { fromGamma } from '../venues/polymarket';
import { polymarket } from '../venues';
import type { Handler } from '../ledger/types';

const log = logger('arb');
const MARGIN = 0.03;

export const scanArb: Handler = async ctx => {
  const events = new Set<string>();
  for (const cid of ctx.hub.watched()) {
    const m = ctx.hub.market(cid);
    if (m?.negRisk && m.eventId) events.add(m.eventId);
  }
  const found: { eventId: string; cost: number; legs: number }[] = [];
  for (const eventId of events) {
    try {
      const ev = await fetchJson<Record<string, any>>(`${config.polymarket.gammaUrl}/events/${eventId}`);
      const markets = ((ev.markets ?? []) as Record<string, any>[])
        .map(m => fromGamma(m, ev))
        .filter((m): m is NonNullable<ReturnType<typeof fromGamma>> => Boolean(m) && m!.active);
      if (markets.length < 2 || markets.length > 40) continue;
      let cost = 0;
      let minDepth = Infinity;
      for (const m of markets) {
        const book = await polymarket.getBook(m, 'YES');
        const ask = book.asks[0];
        if (!ask) {
          cost = Infinity;
          break;
        }
        cost += ask.price + m.feeRate * ask.price * (1 - ask.price);
        minDepth = Math.min(minDepth, ask.size);
      }
      if (cost < 1 - MARGIN) {
        found.push({ eventId, cost, legs: markets.length });
        const msg = `ARBITRAGE: event "${String(ev.title).slice(0, 80)}" — YES on all ${markets.length} outcomes costs ${cost.toFixed(3)} (< 1 − ${MARGIN}); min depth ${minDepth.toFixed(0)} shares`;
        ctx.activity({ sessionId: 0n, level: 'warn', kind: 'arb', message: msg, refId: eventId });
        await ctx.alerts.send('trade', msg);
      }
    } catch (err) {
      log.debug('event scan failed', { eventId, err: String(err) });
    }
  }
  return { result: { events: events.size, found } };
};

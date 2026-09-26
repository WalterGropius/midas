// Manifold Markets (play money). Useful as a live-execution sandbox: the full
// order path runs end to end without real money. Markets are addressed as
// 'manifold:<contractId>'. Manifold is an AMM, so the "book" is synthesized
// from the current probability with a notional depth.
import { config } from '../config';
import { fetchJson } from '../util/async';
import type { Book, OrderAck, Venue, VenueMarket, VenueOrder } from './types';

const PREFIX = 'manifold:';

function fromManifold(m: Record<string, any>): VenueMarket | undefined {
  if (!m?.id || m.outcomeType !== 'BINARY') return undefined;
  const p = Number(m.probability ?? 0.5);
  const resolvedYes = m.isResolved
    ? m.resolution === 'YES'
      ? 1
      : m.resolution === 'NO'
        ? 0
        : m.resolution === 'MKT'
          ? Number(m.resolutionProbability ?? p)
          : undefined
    : undefined;
  return {
    conditionId: `${PREFIX}${m.id}`,
    marketId: String(m.id),
    question: String(m.question ?? ''),
    slug: String(m.slug ?? ''),
    description: typeof m.textDescription === 'string' ? m.textDescription.slice(0, 4000) : '',
    category: (m.groupSlugs?.[0] as string) ?? 'manifold',
    endDate: m.closeTime ? new Date(Number(m.closeTime)).toISOString() : '',
    yesTokenId: String(m.id),
    noTokenId: String(m.id),
    tickSize: 0.01,
    minOrderSize: 1,
    negRisk: false,
    eventId: '',
    negRiskMarketId: '',
    outcomeLabel: '',
    feeRate: 0,
    active: !m.isResolved && (!m.closeTime || Number(m.closeTime) > Date.now()),
    closed: Boolean(m.isResolved),
    bestBid: Math.max(0.01, p - 0.005),
    bestAsk: Math.min(0.99, p + 0.005),
    lastPrice: p,
    volumeDay: Number(m.volume24Hours ?? 0),
    liquidity: Number(m.totalLiquidity ?? 0),
    resolvedYes,
  };
}

function headers(): Record<string, string> {
  return { Authorization: `Key ${config.venues.manifoldApiKey}`, 'Content-Type': 'application/json' };
}

export const manifold: Venue = {
  id: 'manifold',
  canTrade: () => Boolean(config.venues.manifoldApiKey),
  owns: id => id.startsWith(PREFIX),

  async getMarkets(ids) {
    const out: VenueMarket[] = [];
    for (const id of ids) {
      const m = await fetchJson<Record<string, any>>(`${config.venues.manifoldUrl}/market/${id.slice(PREFIX.length)}`);
      const vm = fromManifold(m);
      if (vm) out.push(vm);
    }
    return out;
  },

  async search(query, limit = 20) {
    const res = await fetchJson<Record<string, any>[]>(
      `${config.venues.manifoldUrl}/search-markets?term=${encodeURIComponent(query)}&limit=${limit}&filter=open&contractType=BINARY`
    );
    return res.map(fromManifold).filter((m): m is VenueMarket => Boolean(m));
  },

  async getBook(market, outcome): Promise<Book> {
    const p = outcome === 'YES' ? market.lastPrice : 1 - market.lastPrice;
    // AMM: approximate depth so sizing logic stays uniform across venues
    const depth = Math.max(50, market.liquidity / 4);
    return {
      bids: [{ price: Math.max(0.01, p - 0.01), size: depth }],
      asks: [{ price: Math.min(0.99, p + 0.01), size: depth }],
      tsMs: Date.now(),
      tickSize: 0.01,
      minOrderSize: 1,
    };
  },

  async priceHistory() {
    return [];
  },

  async placeOrder(o: VenueOrder): Promise<OrderAck> {
    if (!this.canTrade()) return { ok: false, externalId: '', status: 'rejected', filledSize: 0, avgPrice: 0, error: 'MANIFOLD_API_KEY missing' };
    if (o.side === 'SELL') {
      const r = await fetchJson<Record<string, any>>(`${config.venues.manifoldUrl}/market/${o.market.marketId}/sell`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ outcome: o.outcome, shares: o.size }),
      });
      return { ok: true, externalId: String(r.betId ?? ''), status: 'filled', filledSize: o.size, avgPrice: o.price };
    }
    const outcome = o.outcome;
    const amount = Math.max(1, Math.round(o.size * o.price));
    // limitProb is always expressed as P(YES)
    const limitProb = Math.min(0.99, Math.max(0.01, outcome === 'YES' ? o.price : 1 - o.price));
    const r = await fetchJson<Record<string, any>>(`${config.venues.manifoldUrl}/bet`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ contractId: o.market.marketId, amount, outcome, limitProb: Number(limitProb.toFixed(2)) }),
    });
    const shares = Number(r.shares ?? 0);
    return {
      ok: true,
      externalId: String(r.betId ?? ''),
      status: r.isFilled ? 'filled' : shares > 0 ? 'partial' : 'open',
      filledSize: shares,
      avgPrice: shares > 0 ? Number(r.amount ?? amount) / shares : 0,
    };
  },

  async cancelOrder(externalId) {
    if (!this.canTrade() || !externalId) return;
    await fetchJson(`${config.venues.manifoldUrl}/bet/cancel/${externalId}`, { method: 'POST', headers: headers() });
  },

  async cancelAll() {
    /* Manifold limit orders expire or are cancelled individually */
  },
};

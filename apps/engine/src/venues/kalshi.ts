// Kalshi (read-only for now). Markets are addressed as 'kalshi:<TICKER>'.
// Trading requires RSA-PSS signed requests and a US account; the order methods
// refuse until that path is implemented and verified.
import { config } from '../config';
import { fetchJson } from '../util/async';
import type { Book, OrderAck, Venue, VenueMarket } from './types';

const PREFIX = 'kalshi:';

// Kalshi has returned prices both as integer cents and as *_dollars strings.
function price(m: Record<string, any>, field: string): number {
  const dollars = m[`${field}_dollars`];
  if (dollars !== undefined && dollars !== null) return Number(dollars);
  const cents = m[field];
  return cents === undefined || cents === null ? NaN : Number(cents) / 100;
}

function fromKalshi(m: Record<string, any>): VenueMarket | undefined {
  if (!m?.ticker) return undefined;
  const status = String(m.status ?? '');
  const result = String(m.result ?? '');
  return {
    conditionId: `${PREFIX}${m.ticker}`,
    marketId: String(m.ticker),
    question: [m.title, m.subtitle ?? m.yes_sub_title].filter(Boolean).join(' — '),
    slug: String(m.ticker).toLowerCase(),
    description: String(m.rules_primary ?? '').slice(0, 4000),
    category: String(m.category ?? 'kalshi'),
    endDate: String(m.close_time ?? m.expiration_time ?? ''),
    yesTokenId: String(m.ticker),
    noTokenId: String(m.ticker),
    tickSize: 0.01,
    minOrderSize: 1,
    negRisk: false,
    eventId: String(m.event_ticker ?? ''),
    negRiskMarketId: '',
    outcomeLabel: String(m.yes_sub_title ?? ''),
    feeRate: 0.07,
    active: status === 'active' || status === 'open',
    closed: ['closed', 'settled', 'finalized'].includes(status),
    bestBid: price(m, 'yes_bid'),
    bestAsk: price(m, 'yes_ask'),
    lastPrice: price(m, 'last_price'),
    volumeDay: Number(m.volume_24h ?? 0),
    liquidity: price(m, 'liquidity') || 0,
    resolvedYes: result === 'yes' ? 1 : result === 'no' ? 0 : undefined,
  };
}

const notYet = async (): Promise<OrderAck> => ({
  ok: false,
  externalId: '',
  status: 'rejected',
  filledSize: 0,
  avgPrice: 0,
  error: 'Kalshi trading is not implemented yet (read-only adapter)',
});

export const kalshi: Venue = {
  id: 'kalshi',
  canTrade: () => false,
  owns: id => id.startsWith(PREFIX),

  async getMarkets(ids) {
    const out: VenueMarket[] = [];
    for (const id of ids) {
      const r = await fetchJson<{ market?: Record<string, any> }>(`${config.venues.kalshiUrl}/markets/${id.slice(PREFIX.length)}`);
      const vm = r.market ? fromKalshi(r.market) : undefined;
      if (vm) out.push(vm);
    }
    return out;
  },

  async search(query, limit = 20) {
    const r = await fetchJson<{ markets?: Record<string, any>[] }>(`${config.venues.kalshiUrl}/markets?status=open&limit=200`);
    const q = query.toLowerCase();
    return (r.markets ?? [])
      .map(fromKalshi)
      .filter((m): m is VenueMarket => Boolean(m) && m!.question.toLowerCase().includes(q))
      .slice(0, limit);
  },

  async getBook(market, outcome): Promise<Book> {
    const r = await fetchJson<{ orderbook?: Record<string, [number, number][] | null> }>(
      `${config.venues.kalshiUrl}/markets/${market.marketId}/orderbook`
    );
    const yes = (r.orderbook?.yes ?? []).map(([p, q]) => ({ price: p / 100, size: q }));
    const no = (r.orderbook?.no ?? []).map(([p, q]) => ({ price: p / 100, size: q }));
    // Kalshi lists bids on both sides; a NO bid at x is a YES ask at 1 − x.
    const yesBids = yes.sort((a, b) => b.price - a.price);
    const yesAsks = no.map(l => ({ price: Number((1 - l.price).toFixed(4)), size: l.size })).sort((a, b) => a.price - b.price);
    const book =
      outcome === 'YES'
        ? { bids: yesBids, asks: yesAsks }
        : {
            bids: no.sort((a, b) => b.price - a.price),
            asks: yes.map(l => ({ price: Number((1 - l.price).toFixed(4)), size: l.size })).sort((a, b) => a.price - b.price),
          };
    return { ...book, tsMs: Date.now(), tickSize: 0.01, minOrderSize: 1 };
  },

  async priceHistory() {
    return [];
  },

  placeOrder: notYet,
  async cancelOrder() {},
  async cancelAll() {},
};

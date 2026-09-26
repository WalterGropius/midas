// A venue is a market we can both read and act on. Every adapter maps its
// native API onto this one bidirectional surface; the rest of the engine never
// sees venue-specific shapes.
import type { BookLevel } from '@midas/core';

export interface VenueMarket {
  /** globally unique id: Polymarket conditionId, or 'manifold:<id>' / 'kalshi:<ticker>' */
  conditionId: string;
  marketId: string;
  question: string;
  slug: string;
  description: string;
  category: string;
  endDate: string;
  yesTokenId: string;
  noTokenId: string;
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  eventId: string;
  negRiskMarketId: string;
  outcomeLabel: string;
  feeRate: number;
  active: boolean;
  closed: boolean;
  bestBid: number;
  bestAsk: number;
  lastPrice: number;
  volumeDay: number;
  liquidity: number;
  /** 1 / 0 (or fractional) once resolved */
  resolvedYes?: number;
}

export interface Book {
  /** best (highest) first */
  bids: BookLevel[];
  /** best (lowest) first */
  asks: BookLevel[];
  tsMs: number;
  tickSize?: number;
  minOrderSize?: number;
}

export type OrderType = 'GTC' | 'GTD' | 'FOK' | 'FAK';

export interface VenueOrder {
  market: VenueMarket;
  outcome: 'YES' | 'NO';
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType: OrderType;
  postOnly?: boolean;
}

export interface OrderAck {
  ok: boolean;
  externalId: string;
  status: string;
  filledSize: number;
  avgPrice: number;
  error?: string;
}

export interface Venue {
  id: string;
  /** true when credentials are configured for placing orders */
  canTrade(): boolean;
  owns(conditionId: string): boolean;
  // read
  getMarkets(conditionIds: string[]): Promise<VenueMarket[]>;
  search(query: string, limit?: number): Promise<VenueMarket[]>;
  getBook(market: VenueMarket, outcome: 'YES' | 'NO'): Promise<Book>;
  priceHistory(market: VenueMarket, opts: { minutes: number; fidelityMin?: number }): Promise<{ tMs: number; p: number }[]>;
  // act
  placeOrder(order: VenueOrder): Promise<OrderAck>;
  cancelOrder(externalId: string): Promise<void>;
  cancelAll(): Promise<void>;
}

export function midOf(book: Book): number | undefined {
  const b = book.bids[0]?.price;
  const a = book.asks[0]?.price;
  if (b !== undefined && a !== undefined) return (a + b) / 2;
  return b ?? a;
}

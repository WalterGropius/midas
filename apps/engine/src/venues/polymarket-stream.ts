// Polymarket market-channel WebSocket: live books and trades for the tokens we
// watch. Keepalive is a text "PING" every 10 s (the reply "PONG" is not JSON);
// the first book snapshot arrives wrapped in an array.
import { config } from '../config';
import { logger } from '../log';

const log = logger('pm-ws');

export interface TopOfBook {
  tokenId: string;
  bestBid: number;
  bestAsk: number;
  lastTrade?: number;
  tsMs: number;
}

type Side = Map<number, number>; // price → size

export class PolymarketStream {
  private ws?: WebSocket;
  private tokens = new Set<string>();
  private books = new Map<string, { bids: Side; asks: Side; last?: number; tsMs: number }>();
  private ping?: NodeJS.Timeout;
  private backoff = 1000;
  private closed = false;
  lastMessageMs = 0;

  constructor(private onTop: (top: TopOfBook) => void, private onResolved?: (tokenId: string) => void) {}

  top(tokenId: string): TopOfBook | undefined {
    const b = this.books.get(tokenId);
    if (!b) return undefined;
    const bid = Math.max(0, ...b.bids.keys());
    const asks = [...b.asks.keys()];
    const ask = asks.length ? Math.min(...asks) : 1;
    return { tokenId, bestBid: bid, bestAsk: ask, lastTrade: b.last, tsMs: b.tsMs };
  }

  /** Levels for book walking (best first). */
  levels(tokenId: string): { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | undefined {
    const b = this.books.get(tokenId);
    if (!b) return undefined;
    return {
      bids: [...b.bids.entries()].map(([price, size]) => ({ price, size })).sort((x, y) => y.price - x.price),
      asks: [...b.asks.entries()].map(([price, size]) => ({ price, size })).sort((x, y) => x.price - y.price),
    };
  }

  setTokens(tokenIds: string[]) {
    const next = new Set(tokenIds.filter(Boolean));
    const added = [...next].filter(t => !this.tokens.has(t));
    const removed = [...this.tokens].filter(t => !next.has(t));
    this.tokens = next;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!this.ws && next.size > 0) this.connect();
      return;
    }
    if (added.length) this.ws.send(JSON.stringify({ assets_ids: added, operation: 'subscribe' }));
    if (removed.length) {
      this.ws.send(JSON.stringify({ assets_ids: removed, operation: 'unsubscribe' }));
      for (const t of removed) this.books.delete(t);
    }
  }

  private connect() {
    if (this.closed || this.tokens.size === 0) return;
    const ws = new WebSocket(config.polymarket.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      ws.send(JSON.stringify({ assets_ids: [...this.tokens], type: 'market', custom_feature_enabled: true }));
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('PING'), 10_000);
      log.info('connected', { tokens: this.tokens.size });
    };
    ws.onmessage = ev => {
      const data = String(ev.data);
      if (data === 'PONG' || data === 'PING') return;
      this.lastMessageMs = Date.now();
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      for (const m of Array.isArray(msg) ? msg : [msg]) this.handle(m as Record<string, any>);
    };
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.ws = undefined;
      if (this.closed) return;
      const delay = this.backoff;
      this.backoff = Math.min(60_000, this.backoff * 2);
      log.warn('disconnected; reconnecting', { delayMs: delay });
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private handle(m: Record<string, any>) {
    const now = Date.now();
    switch (m.event_type) {
      case 'book': {
        const bids: Side = new Map();
        const asks: Side = new Map();
        for (const l of m.bids ?? []) if (Number(l.size) > 0) bids.set(Number(l.price), Number(l.size));
        for (const l of m.asks ?? []) if (Number(l.size) > 0) asks.set(Number(l.price), Number(l.size));
        const prev = this.books.get(m.asset_id);
        this.books.set(m.asset_id, { bids, asks, last: prev?.last ?? (m.last_trade_price ? Number(m.last_trade_price) : undefined), tsMs: now });
        this.emit(m.asset_id);
        break;
      }
      case 'price_change': {
        const touched = new Set<string>();
        for (const c of m.price_changes ?? []) {
          const b = this.books.get(c.asset_id);
          if (!b) continue;
          const side = c.side === 'BUY' ? b.bids : b.asks;
          const price = Number(c.price);
          const size = Number(c.size);
          if (size > 0) side.set(price, size);
          else side.delete(price);
          b.tsMs = now;
          touched.add(c.asset_id);
        }
        for (const t of touched) this.emit(t);
        break;
      }
      case 'last_trade_price': {
        const b = this.books.get(m.asset_id);
        if (b) {
          b.last = Number(m.price);
          b.tsMs = now;
          this.emit(m.asset_id);
        }
        break;
      }
      case 'market_resolved': {
        if (m.winning_asset_id) this.onResolved?.(String(m.winning_asset_id));
        break;
      }
      default:
        break;
    }
  }

  private emit(tokenId: string) {
    const t = this.top(tokenId);
    if (t) this.onTop(t);
  }

  close() {
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
  }
}

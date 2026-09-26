// Market hub: which markets matter, their live prices, and 1-minute bars.
//
// Watched = every market in a live session + every market with an open
// position. Metadata refreshes from the venues; Polymarket prices stream over
// the WebSocket; bars are written to SpacetimeDB once per minute (the UI charts
// them, TimesFM reads them, the scorer measures reactions on them).
import type { Market } from '@midas/stdb-bindings/types';
import { type Bar } from '@midas/core';
import type { Conn } from '../stdb';
import { logger } from '../log';
import { msFromTs, tsFromMs } from '../util/time';
import { PolymarketStream, type TopOfBook } from '../venues/polymarket-stream';
import { midOf, venueFor, VENUES, type Book, type VenueMarket } from '../venues';

const log = logger('hub');

const LIVE_STATUSES = new Set(['running', 'paused', 'pending_approval']);

interface Live {
  mid: number;
  bid: number;
  ask: number;
  tsMs: number;
}

interface OpenBar {
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bid: number;
  ask: number;
}

export function toMarketInput(m: VenueMarket) {
  return {
    conditionId: m.conditionId,
    marketId: m.marketId,
    question: m.question,
    slug: m.slug,
    description: m.description,
    category: m.category,
    endDate: m.endDate,
    yesTokenId: m.yesTokenId,
    noTokenId: m.noTokenId,
    tickSize: m.tickSize,
    minOrderSize: m.minOrderSize,
    negRisk: m.negRisk,
    eventId: m.eventId,
    negRiskMarketId: m.negRiskMarketId,
    outcomeLabel: m.outcomeLabel,
    feeRate: m.feeRate,
    active: m.active,
    closed: m.closed,
    bestBid: Number.isFinite(m.bestBid) ? m.bestBid : 0,
    bestAsk: Number.isFinite(m.bestAsk) ? m.bestAsk : 1,
    lastPrice: Number.isFinite(m.lastPrice) ? m.lastPrice : 0.5,
    volumeDay: m.volumeDay,
    liquidity: m.liquidity,
  };
}

export function rowToVenueMarket(r: Market): VenueMarket {
  return {
    conditionId: r.conditionId,
    marketId: r.marketId,
    question: r.question,
    slug: r.slug,
    description: r.description,
    category: r.category,
    endDate: r.endDate,
    yesTokenId: r.yesTokenId,
    noTokenId: r.noTokenId,
    tickSize: r.tickSize,
    minOrderSize: r.minOrderSize,
    negRisk: r.negRisk,
    eventId: r.eventId,
    negRiskMarketId: r.negRiskMarketId,
    outcomeLabel: r.outcomeLabel,
    feeRate: r.feeRate,
    active: r.active,
    closed: r.closed,
    bestBid: r.bestBid,
    bestAsk: r.bestAsk,
    lastPrice: r.lastPrice,
    volumeDay: r.volumeDay,
    liquidity: r.liquidity,
    resolvedYes: r.outcomeYes,
  };
}

export class MarketHub {
  private live = new Map<string, Live>();
  private bars = new Map<string, OpenBar>();
  private tokenToCondition = new Map<string, string>();
  private backfilled = new Set<string>();
  readonly stream: PolymarketStream;

  // Client-side index lookups scan the whole table in this SDK version, so
  // bars are cached per market and kept current from insert callbacks.
  private barCache?: Map<string, Bar[]>;

  constructor(private conn: Conn) {
    this.stream = new PolymarketStream(
      top => this.onTop(top),
      winningToken => log.info('resolution event', { token: winningToken.slice(0, 12) })
    );
    conn.db.priceBar.onInsert((_ctx, row) => {
      if (!this.barCache) return;
      const list = this.barCache.get(row.conditionId) ?? [];
      const bar = { tsMs: msFromTs(row.ts), close: row.close };
      if (list.length === 0 || list[list.length - 1].tsMs <= bar.tsMs) list.push(bar);
      else list.splice(list.findIndex(b => b.tsMs > bar.tsMs), 0, bar);
      this.barCache.set(row.conditionId, list);
    });
    conn.db.priceBar.onDelete((_ctx, row) => {
      const list = this.barCache?.get(row.conditionId);
      if (!list) return;
      const t = msFromTs(row.ts);
      const i = list.findIndex(b => b.tsMs === t);
      if (i >= 0) list.splice(i, 1);
    });
  }

  watched(): Set<string> {
    const live = new Set<bigint>();
    for (const s of this.conn.db.session.iter()) if (LIVE_STATUSES.has(s.status)) live.add(s.id);
    const ids = new Set<string>();
    for (const sm of this.conn.db.sessionMarket.iter()) if (live.has(sm.sessionId)) ids.add(sm.conditionId);
    for (const p of this.conn.db.position.iter()) if (!p.closed) ids.add(p.conditionId);
    return ids;
  }

  market(conditionId: string): Market | undefined {
    return this.conn.db.market.conditionId.find(conditionId) ?? undefined;
  }

  venueMarket(conditionId: string): VenueMarket | undefined {
    const r = this.market(conditionId);
    return r ? rowToVenueMarket(r) : undefined;
  }

  /** Refresh metadata for watched markets; detect resolutions; retarget the stream. */
  async refresh() {
    const ids = [...this.watched()];
    if (ids.length === 0) {
      this.stream.setTokens([]);
      return;
    }
    const fetched: VenueMarket[] = [];
    for (const v of VENUES) {
      const mine = ids.filter(id => v.owns(id));
      if (mine.length === 0) continue;
      try {
        fetched.push(...(await v.getMarkets(mine)));
      } catch (err) {
        log.warn('market refresh failed', { venue: v.id, err: String(err) });
      }
    }
    if (fetched.length > 0) await this.conn.reducers.upsertMarkets({ markets: fetched.map(toMarketInput) });
    for (const m of fetched) {
      if (m.resolvedYes !== undefined && !this.market(m.conditionId)?.resolved) {
        await this.conn.reducers.setMarketResolution({ conditionId: m.conditionId, outcomeYes: m.resolvedYes });
      }
      if (m.yesTokenId) this.tokenToCondition.set(m.yesTokenId, m.conditionId);
      // seed live prices from metadata until the stream speaks
      if (!this.live.has(m.conditionId) && Number.isFinite(m.bestBid) && Number.isFinite(m.bestAsk)) {
        this.live.set(m.conditionId, { bid: m.bestBid, ask: m.bestAsk, mid: (m.bestBid + m.bestAsk) / 2, tsMs: Date.now() });
      }
    }
    const pmTokens = fetched.filter(m => m.conditionId.startsWith('0x') && m.active).map(m => m.yesTokenId);
    this.stream.setTokens(pmTokens);
    for (const m of fetched) if (!this.backfilled.has(m.conditionId)) await this.backfill(m);
  }

  /** On first sight, load a day of history so charts and TimesFM have context at once. */
  private async backfill(m: VenueMarket) {
    this.backfilled.add(m.conditionId);
    const existing = this.bars1m(m.conditionId).length;
    if (existing > 60) return;
    try {
      const hist = await venueFor(m.conditionId).priceHistory(m, { minutes: 24 * 60, fidelityMin: 5 });
      if (hist.length === 0) return;
      const bars = hist.map(h => ({
        conditionId: m.conditionId,
        ts: tsFromMs(h.tMs),
        open: h.p,
        high: h.p,
        low: h.p,
        close: h.p,
        bid: h.p,
        ask: h.p,
      }));
      for (let i = 0; i < bars.length; i += 500) await this.conn.reducers.insertPriceBars({ bars: bars.slice(i, i + 500) });
      log.info('backfilled', { market: m.slug || m.conditionId.slice(0, 10), bars: bars.length });
    } catch (err) {
      log.warn('backfill failed', { market: m.conditionId.slice(0, 10), err: String(err) });
    }
  }

  private onTop(top: TopOfBook) {
    const cid = this.tokenToCondition.get(top.tokenId);
    if (!cid) return;
    const spread = top.bestAsk - top.bestBid;
    const mid = spread <= 0.1 || top.lastTrade === undefined ? (top.bestAsk + top.bestBid) / 2 : top.lastTrade;
    this.observe(cid, { mid, bid: top.bestBid, ask: top.bestAsk, tsMs: top.tsMs });
  }

  observe(conditionId: string, l: Live) {
    this.live.set(conditionId, l);
    const minute = Math.floor(l.tsMs / 60_000);
    const bar = this.bars.get(conditionId);
    if (!bar || bar.minute !== minute) {
      this.bars.set(conditionId, { minute, open: l.mid, high: l.mid, low: l.mid, close: l.mid, bid: l.bid, ask: l.ask });
      if (bar) this.pendingBars.push({ conditionId, bar });
    } else {
      bar.high = Math.max(bar.high, l.mid);
      bar.low = Math.min(bar.low, l.mid);
      bar.close = l.mid;
      bar.bid = l.bid;
      bar.ask = l.ask;
    }
  }

  private pendingBars: { conditionId: string; bar: OpenBar }[] = [];

  /** Write completed bars; markets without stream ticks get a bar from polling. */
  async flushBars() {
    const nowMin = Math.floor(Date.now() / 60_000);
    for (const [cid, bar] of this.bars) {
      if (bar.minute < nowMin) {
        this.pendingBars.push({ conditionId: cid, bar });
        this.bars.delete(cid);
      }
    }
    // carry forward markets that did not tick this minute so bars stay continuous
    for (const cid of this.watched()) {
      const l = this.live.get(cid);
      if (!l || this.bars.has(cid) || this.pendingBars.some(p => p.conditionId === cid)) continue;
      this.pendingBars.push({ conditionId: cid, bar: { minute: nowMin - 1, open: l.mid, high: l.mid, low: l.mid, close: l.mid, bid: l.bid, ask: l.ask } });
    }
    if (this.pendingBars.length === 0) return;
    const batch = this.pendingBars.splice(0, 500);
    await this.conn.reducers.insertPriceBars({
      bars: batch.map(({ conditionId, bar }) => ({
        conditionId,
        ts: tsFromMs(bar.minute * 60_000),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        bid: bar.bid,
        ask: bar.ask,
      })),
    });
  }

  /** Poll books for watched markets the stream does not cover (other venues). */
  async pollNonStreamed() {
    for (const cid of this.watched()) {
      if (cid.startsWith('0x')) continue;
      const m = this.venueMarket(cid);
      if (!m || !m.active) continue;
      try {
        const book = await venueFor(cid).getBook(m, 'YES');
        const mid = midOf(book);
        if (mid !== undefined) this.observe(cid, { mid, bid: book.bids[0]?.price ?? mid, ask: book.asks[0]?.price ?? mid, tsMs: Date.now() });
      } catch (err) {
        log.debug('poll failed', { market: cid, err: String(err) });
      }
    }
  }

  price(conditionId: string): Live | undefined {
    const l = this.live.get(conditionId);
    if (l) return l;
    const m = this.market(conditionId);
    if (!m) return undefined;
    const bid = m.bestBid;
    const ask = m.bestAsk;
    return { bid, ask, mid: Number.isFinite(bid + ask) && ask > bid ? (bid + ask) / 2 : m.lastPrice, tsMs: msFromTs(m.updatedAt) };
  }

  /**
   * Fresh book straight from the venue. Memory is a hint: every order is
   * sized against a book fetched moments before, never against the cache.
   */
  async freshBook(conditionId: string, outcome: 'YES' | 'NO'): Promise<Book | undefined> {
    const m = this.venueMarket(conditionId);
    if (!m) return undefined;
    return venueFor(conditionId).getBook(m, outcome);
  }

  bars1m(conditionId: string, sinceMs = 0): Bar[] {
    if (!this.barCache) {
      this.barCache = new Map();
      for (const b of this.conn.db.priceBar.iter()) {
        const list = this.barCache.get(b.conditionId) ?? [];
        list.push({ tsMs: msFromTs(b.ts), close: b.close });
        this.barCache.set(b.conditionId, list);
      }
      for (const list of this.barCache.values()) list.sort((a, b) => a.tsMs - b.tsMs);
    }
    const list = this.barCache.get(conditionId) ?? [];
    if (sinceMs <= 0) return list.slice();
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].tsMs < sinceMs) lo = mid + 1;
      else hi = mid;
    }
    return list.slice(lo);
  }
}

// Polymarket: Gamma (metadata/search), CLOB V2 REST (books, history) and
// order placement through @polymarket/clob-client-v2 with a viem signer.
// CLOB V2 went live 2026-04-28 (pUSD collateral); V1 clients are rejected.
import type { BookLevel } from '@midas/core';
import { config } from '../config';
import { logger } from '../log';
import { fetchJson, retry } from '../util/async';
import type { Book, OrderAck, Venue, VenueMarket, VenueOrder } from './types';

const log = logger('polymarket');

function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function n(v: unknown, dflt = 0): number {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : dflt;
}

/** Map a Gamma market object (outcomes/prices/tokens are JSON strings). */
export function fromGamma(m: Record<string, any>, event?: Record<string, any>): VenueMarket | undefined {
  const tokens = parseJsonArray(m.clobTokenIds);
  const outcomes = parseJsonArray(m.outcomes).map(o => o.toLowerCase());
  const prices = parseJsonArray(m.outcomePrices).map(Number);
  if (!m.conditionId || tokens.length < 2) return undefined;
  const yesIdx = Math.max(0, outcomes.indexOf('yes'));
  const noIdx = yesIdx === 0 ? 1 : 0;
  const closed = Boolean(m.closed);
  const yesPrice = prices[yesIdx];
  const resolvedYes =
    closed && Number.isFinite(yesPrice) && (yesPrice >= 0.99 || yesPrice <= 0.01) ? (yesPrice >= 0.99 ? 1 : 0) : undefined;
  const tags = (event?.tags ?? m.tags ?? []) as { label?: string; slug?: string }[];
  return {
    conditionId: String(m.conditionId),
    marketId: String(m.id ?? ''),
    question: String(m.question ?? ''),
    slug: String(m.slug ?? ''),
    description: String(m.description ?? '').slice(0, 4000),
    category: String(m.category ?? tags[0]?.label ?? event?.category ?? ''),
    endDate: String(m.endDate ?? m.endDateIso ?? ''),
    yesTokenId: tokens[yesIdx],
    noTokenId: tokens[noIdx],
    tickSize: n(m.orderPriceMinTickSize, 0.01),
    minOrderSize: n(m.orderMinSize, 5),
    negRisk: Boolean(m.negRisk),
    eventId: String(event?.id ?? m.events?.[0]?.id ?? ''),
    negRiskMarketId: String(m.negRiskMarketID ?? ''),
    outcomeLabel: String(m.groupItemTitle ?? ''),
    feeRate: m.feesEnabled === false ? 0 : n(m.feeSchedule?.rate, config.polymarket.defaultFeeRate),
    active: Boolean(m.active) && !closed && m.acceptingOrders !== false,
    closed,
    bestBid: n(m.bestBid, NaN),
    bestAsk: n(m.bestAsk, NaN),
    lastPrice: n(m.lastTradePrice, Number.isFinite(yesPrice) ? yesPrice : 0.5),
    volumeDay: n(m.volume24hr),
    liquidity: n(m.liquidityNum ?? m.liquidity),
    resolvedYes,
  };
}

function levels(raw: { price: string; size: string }[] | undefined): BookLevel[] {
  return (raw ?? []).map(l => ({ price: Number(l.price), size: Number(l.size) })).filter(l => l.size > 0);
}

// ─────────────────────────── trading client (lazy) ───────────────────────────

interface ClobV2 {
  createOrDeriveApiKey(): Promise<{ key: string; secret: string; passphrase: string }>;
  createAndPostOrder(
    order: { tokenID: string; price: number; size: number; side: string },
    options: { tickSize: string; negRisk?: boolean },
    orderType?: string,
    postOnly?: boolean
  ): Promise<{ success: boolean; errorMsg: string; orderID: string; status: string; takingAmount: string; makingAmount: string }>;
  createAndPostMarketOrder(
    order: { tokenID: string; price?: number; amount: number; side: string },
    options: { tickSize: string; negRisk?: boolean },
    orderType?: string
  ): Promise<{ success: boolean; errorMsg: string; orderID: string; status: string; takingAmount: string; makingAmount: string }>;
  cancelOrder(p: { orderID: string }): Promise<unknown>;
  cancelAll(): Promise<unknown>;
}

let clobPromise: Promise<ClobV2> | undefined;

async function clob(): Promise<ClobV2> {
  clobPromise ??= (async () => {
    // Loaded only when live trading is configured, so paper mode needs no wallet deps.
    const mod = (await import('@polymarket/clob-client-v2')) as any;
    const { createWalletClient, http } = (await import('viem')) as any;
    const { privateKeyToAccount } = (await import('viem/accounts')) as any;
    const { polygon } = (await import('viem/chains')) as any;
    const pk = config.live.privateKey.startsWith('0x') ? config.live.privateKey : `0x${config.live.privateKey}`;
    const signer = createWalletClient({ account: privateKeyToAccount(pk), chain: polygon, transport: http() });
    const l1 = new mod.ClobClient({ host: config.polymarket.clobUrl, chain: mod.Chain.POLYGON, signer });
    const creds = await l1.createOrDeriveApiKey();
    const client = new mod.ClobClient({
      host: config.polymarket.clobUrl,
      chain: mod.Chain.POLYGON,
      signer,
      creds,
      signatureType: config.live.signatureType,
      funderAddress: config.live.funder || undefined,
      throwOnError: true,
    });
    log.info('CLOB V2 trading client ready', { signatureType: config.live.signatureType });
    return client as ClobV2;
  })();
  return clobPromise;
}

function tickString(t: number): string {
  const allowed = ['0.1', '0.01', '0.005', '0.0025', '0.001', '0.0001'];
  return allowed.find(a => Math.abs(Number(a) - t) < 1e-9) ?? '0.01';
}

export function roundToTick(price: number, tick: number, side: 'BUY' | 'SELL'): number {
  const steps = side === 'BUY' ? Math.floor(price / tick + 1e-9) : Math.ceil(price / tick - 1e-9);
  return Math.min(1 - tick, Math.max(tick, Number((steps * tick).toFixed(6))));
}

export const polymarket: Venue = {
  id: 'polymarket',
  canTrade: () => config.live.enabled && Boolean(config.live.privateKey),
  owns: id => id.startsWith('0x'),

  async getMarkets(conditionIds) {
    const out: VenueMarket[] = [];
    for (let i = 0; i < conditionIds.length; i += 20) {
      const chunk = conditionIds.slice(i, i + 20);
      const qs = chunk.map(c => `condition_ids=${encodeURIComponent(c)}`).join('&');
      // closed defaults to false on Gamma; ask for both so resolutions are seen
      const [open, closed] = await Promise.all(
        [false, true].map(c =>
          retry(() => fetchJson<Record<string, any>[]>(`${config.polymarket.gammaUrl}/markets?${qs}&closed=${c}&limit=100`), {
            label: 'gamma.markets',
          })
        )
      );
      for (const m of [...(open ?? []), ...(closed ?? [])]) {
        const vm = fromGamma(m);
        if (vm && !out.some(x => x.conditionId === vm.conditionId)) out.push(vm);
      }
    }
    return out;
  },

  async search(query, limit = 20) {
    const res = await fetchJson<{ events?: Record<string, any>[] }>(
      `${config.polymarket.gammaUrl}/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}&events_status=active`
    );
    const out: VenueMarket[] = [];
    for (const ev of res.events ?? []) for (const m of ev.markets ?? []) {
      const vm = fromGamma(m, ev);
      if (vm && vm.active) out.push(vm);
    }
    return out.slice(0, limit * 3);
  },

  async getBook(market, outcome) {
    const tokenId = outcome === 'YES' ? market.yesTokenId : market.noTokenId;
    const raw = await retry(
      () =>
        fetchJson<{ bids: { price: string; size: string }[]; asks: { price: string; size: string }[]; tick_size?: string; min_order_size?: string }>(
          `${config.polymarket.clobUrl}/book?token_id=${tokenId}`,
          { timeoutMs: 8000 }
        ),
      { label: 'clob.book', attempts: 2 }
    );
    // CLOB returns bids ascending and asks descending (best LAST); normalize.
    return {
      bids: levels(raw.bids).sort((a, b) => b.price - a.price),
      asks: levels(raw.asks).sort((a, b) => a.price - b.price),
      tsMs: Date.now(),
      tickSize: raw.tick_size ? Number(raw.tick_size) : market.tickSize,
      minOrderSize: raw.min_order_size ? Number(raw.min_order_size) : market.minOrderSize,
    };
  },

  async priceHistory(market, { minutes, fidelityMin = 1 }) {
    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - minutes * 60;
    const res = await fetchJson<{ history?: { t: number; p: number }[] }>(
      `${config.polymarket.clobUrl}/prices-history?market=${market.yesTokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelityMin}`
    );
    return (res.history ?? []).map(h => ({ tMs: h.t * 1000, p: Number(h.p) })).filter(h => Number.isFinite(h.p));
  },

  async placeOrder(o: VenueOrder): Promise<OrderAck> {
    if (!this.canTrade()) return { ok: false, externalId: '', status: 'rejected', filledSize: 0, avgPrice: 0, error: 'live trading not configured' };
    const c = await clob();
    const price = roundToTick(o.price, o.market.tickSize || 0.01, o.side);
    const opts = { tickSize: tickString(o.market.tickSize), negRisk: o.market.negRisk };
    try {
      // FAK/FOK take liquidity now (amount = USD for BUY, shares for SELL; price = worst acceptable);
      // GTC/GTD rest on the book (optionally post-only, i.e. maker, fee-free).
      const r =
        o.orderType === 'FAK' || o.orderType === 'FOK'
          ? await c.createAndPostMarketOrder(
              { tokenID: o.tokenId, price, amount: Number((o.side === 'BUY' ? o.size * price : o.size).toFixed(2)), side: o.side },
              opts,
              o.orderType
            )
          : await c.createAndPostOrder({ tokenID: o.tokenId, price, size: Number(o.size.toFixed(2)), side: o.side }, opts, o.orderType, o.postOnly ?? false);
      const taking = Number(r.takingAmount || 0);
      const making = Number(r.makingAmount || 0);
      // BUY: making = USD paid, taking = shares received (immediate fills only)
      const filled = o.side === 'BUY' ? taking : making;
      const avg = filled > 0 ? (o.side === 'BUY' ? making / taking : taking / making) : 0;
      return {
        ok: r.success,
        externalId: r.orderID ?? '',
        status: r.success ? (filled >= o.size - 1e-6 ? 'filled' : filled > 0 ? 'partial' : 'open') : 'rejected',
        filledSize: filled,
        avgPrice: avg,
        error: r.errorMsg || undefined,
      };
    } catch (err) {
      return { ok: false, externalId: '', status: 'rejected', filledSize: 0, avgPrice: 0, error: String(err) };
    }
  },

  async cancelOrder(externalId) {
    if (!this.canTrade()) return;
    await (await clob()).cancelOrder({ orderID: externalId });
  },

  async cancelAll() {
    if (!this.canTrade()) return;
    await (await clob()).cancelAll();
  },
};

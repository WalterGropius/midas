// Polymarket Gamma API, called straight from the browser (CORS is open).
// outcomes / outcomePrices / clobTokenIds arrive as JSON-encoded strings.

const GAMMA = 'https://gamma-api.polymarket.com';
const DEFAULT_FEE_RATE = 0.05; // Fee Structure V2 default when a market carries no schedule

export interface GammaMarket {
  conditionId: string;
  question: string;
  slug: string;
  groupItemTitle: string;
  eventTitle: string;
  eventSlug: string;
  outcomes: string[];
  yesPrice: number | undefined;
  volume24h: number;
  liquidity: number;
  endDate: string;
  active: boolean;
  closed: boolean;
  negRisk: boolean;
  feeRate: number;
}

type Raw = Record<string, unknown>;

function jsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

function n(v: unknown, dflt = 0): number {
  const x = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(x) ? x : dflt;
}

export function parseMarket(m: Raw, event?: Raw): GammaMarket | undefined {
  if (!m.conditionId) return undefined;
  const outcomes = jsonArray(m.outcomes);
  const prices = jsonArray(m.outcomePrices).map(Number);
  const yesIdx = Math.max(0, outcomes.findIndex(o => o.toLowerCase() === 'yes'));
  const fee = m.feeSchedule as { rate?: unknown } | undefined;
  const ev = event ?? ((m.events as Raw[] | undefined)?.[0] as Raw | undefined);
  return {
    conditionId: String(m.conditionId),
    question: String(m.question ?? ''),
    slug: String(m.slug ?? ''),
    groupItemTitle: String(m.groupItemTitle ?? ''),
    eventTitle: String(ev?.title ?? ''),
    eventSlug: String(ev?.slug ?? ''),
    outcomes,
    yesPrice: Number.isFinite(prices[yesIdx]) ? prices[yesIdx] : undefined,
    volume24h: n(m.volume24hr),
    liquidity: n(m.liquidityNum ?? m.liquidity),
    endDate: String(m.endDate ?? m.endDateIso ?? ''),
    active: Boolean(m.active),
    closed: Boolean(m.closed),
    negRisk: Boolean(m.negRisk),
    feeRate: m.feesEnabled === false ? 0 : n(fee?.rate, DEFAULT_FEE_RATE),
  };
}

async function get(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${GAMMA}${path}`, { signal, headers: { Accept: 'application/json' } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Polymarket search failed (HTTP ${res.status})`);
  return res.json();
}

export async function searchMarkets(q: string, signal?: AbortSignal): Promise<GammaMarket[]> {
  const params = new URLSearchParams({ q, limit_per_type: '20', events_status: 'active' });
  const data = (await get(`/public-search?${params}`, signal)) as { events?: Raw[] } | undefined;
  const out: GammaMarket[] = [];
  for (const ev of data?.events ?? []) {
    for (const m of (ev.markets as Raw[] | undefined) ?? []) {
      const pm = parseMarket(m, ev);
      if (pm && !pm.closed) out.push(pm);
    }
  }
  return out;
}

/** Extract a slug from a polymarket.com URL (event or market) or return the input. */
export function slugFromInput(input: string): string | undefined {
  const s = input.trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (!/polymarket\.com$/i.test(u.hostname)) return undefined;
    const parts = u.pathname.split('/').filter(Boolean);
    // /event/<event-slug>[/<market-slug>] or /market/<slug>
    return parts[parts.length - 1];
  } catch {
    return /^[a-z0-9]+(-[a-z0-9]+)+$/i.test(s) ? s.toLowerCase() : undefined;
  }
}

/** Resolve a pasted URL or slug: a single market, or every open market of an event. */
export async function lookupSlug(slug: string, signal?: AbortSignal): Promise<GammaMarket[]> {
  const market = (await get(`/markets/slug/${encodeURIComponent(slug)}`, signal)) as Raw | undefined;
  if (market && market.conditionId) {
    const pm = parseMarket(market);
    return pm ? [pm] : [];
  }
  const event = (await get(`/events/slug/${encodeURIComponent(slug)}`, signal)) as Raw | undefined;
  if (event && Array.isArray(event.markets)) {
    return (event.markets as Raw[]).map(m => parseMarket(m, event)).filter((m): m is GammaMarket => !!m && !m.closed);
  }
  return [];
}

export function marketTitle(m: Pick<GammaMarket, 'question' | 'groupItemTitle' | 'eventTitle'>): string {
  return m.question || (m.eventTitle && m.groupItemTitle ? `${m.eventTitle} — ${m.groupItemTitle}` : m.eventTitle);
}

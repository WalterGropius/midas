// LLM usage meter: per (route, model) tokens, cache hits and cost, flushed to
// SpacetimeDB so the UI can show spend and cache hit rate. "A cache you can't
// measure is a discount you don't get."
import type { Conn } from '../stdb';
import { config } from '../config';
import { logger } from '../log';
import { utcDay } from '../util/time';

const log = logger('usage');

export interface UsageDelta {
  route: string;
  model: string;
  tier: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  thoughtTokens: number;
}

interface Bucket {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  thoughtTokens: number;
  costUsd: number;
}

export function costOf(tier: string, u: Omit<UsageDelta, 'route' | 'model' | 'tier'>): number {
  const [pin, pcached, pout] = config.gemini.price[tier] ?? config.gemini.price.flash;
  const uncached = Math.max(0, u.tokensIn - u.cachedTokens);
  return (uncached * pin + u.cachedTokens * pcached + (u.tokensOut + u.thoughtTokens) * pout) / 1_000_000;
}

class UsageMeter {
  private buckets = new Map<string, Bucket & { route: string; model: string }>();
  private day = utcDay();
  private spentToday = 0;
  private spentBySession = new Map<string, number>();

  record(u: UsageDelta, sessionId?: bigint): number {
    const cost = costOf(u.tier, u);
    const key = `${u.route}|${u.model}`;
    const b = this.buckets.get(key) ?? {
      route: u.route,
      model: u.model,
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      cachedTokens: 0,
      thoughtTokens: 0,
      costUsd: 0,
    };
    b.calls++;
    b.tokensIn += u.tokensIn;
    b.tokensOut += u.tokensOut;
    b.cachedTokens += u.cachedTokens;
    b.thoughtTokens += u.thoughtTokens;
    b.costUsd += cost;
    this.buckets.set(key, b);
    this.rollDay();
    this.spentToday += cost;
    if (sessionId !== undefined) {
      const k = sessionId.toString();
      this.spentBySession.set(k, (this.spentBySession.get(k) ?? 0) + cost);
    }
    const hit = u.tokensIn > 0 ? Math.round((100 * u.cachedTokens) / u.tokensIn) : 0;
    log.debug('[cache]', { route: u.route, model: u.model, cached: u.cachedTokens, in: u.tokensIn, hit: `${hit}%` });
    return cost;
  }

  private rollDay() {
    const d = utcDay();
    if (d !== this.day) {
      this.day = d;
      this.spentToday = 0;
      this.spentBySession.clear();
    }
  }

  /** Record a call whose cost the provider reported directly (OpenRouter). */
  recordCost(
    u: { route: string; model: string; tokensIn: number; tokensOut: number; cachedTokens: number; costUsd: number },
    sessionId?: bigint
  ): number {
    const key = `${u.route}|${u.model}`;
    const b = this.buckets.get(key) ?? { route: u.route, model: u.model, calls: 0, tokensIn: 0, tokensOut: 0, cachedTokens: 0, thoughtTokens: 0, costUsd: 0 };
    b.calls++;
    b.tokensIn += u.tokensIn;
    b.tokensOut += u.tokensOut;
    b.cachedTokens += u.cachedTokens;
    b.costUsd += u.costUsd;
    this.buckets.set(key, b);
    this.rollDay();
    this.spentToday += u.costUsd;
    if (sessionId !== undefined) {
      const k = sessionId.toString();
      this.spentBySession.set(k, (this.spentBySession.get(k) ?? 0) + u.costUsd);
    }
    return u.costUsd;
  }

  spent(): number {
    this.rollDay();
    return this.spentToday;
  }

  spentForSession(sessionId: bigint): number {
    this.rollDay();
    return this.spentBySession.get(sessionId.toString()) ?? 0;
  }

  overGlobalBudget(): boolean {
    return this.spent() >= config.gemini.globalDailyBudgetUsd;
  }

  async flush(conn: Conn) {
    if (this.buckets.size === 0) return;
    const usages = [...this.buckets.values()].map(b => ({
      route: b.route,
      model: b.model,
      calls: b.calls,
      tokensIn: b.tokensIn,
      tokensOut: b.tokensOut,
      cachedTokens: b.cachedTokens,
      thoughtTokens: b.thoughtTokens,
      costUsd: b.costUsd,
    }));
    this.buckets.clear();
    const hit = usages.reduce((s, u) => s + u.cachedTokens, 0) / Math.max(1, usages.reduce((s, u) => s + u.tokensIn, 0));
    log.info('[cache] flush', { routes: usages.length, hit: `${Math.round(hit * 100)}%`, spentToday: this.spent().toFixed(3) });
    await conn.reducers.recordLlmUsage({ usages });
  }
}

export const usage = new UsageMeter();

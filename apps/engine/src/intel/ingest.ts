// L0 ingest: RSS (and pushed news) → dedupe → news_item rows → triage tasks.
// Pure code, no model calls: hashing, near-duplicate detection, freshness and
// regex urgency decide the queue order.
import { isNearDuplicate, newsHash, parseSeedYaml, regexUrgency, truncate } from '@midas/core';
import type { EngineCtx } from '../ctx';
import { config } from '../config';
import { DEFAULT_FEED_IDS, RssPoller, type FeedItem } from '../feeds/rss';
import { logger } from '../log';
import { tsFromMs } from '../util/time';
import { byUnique } from '../util/rows';

const log = logger('ingest');
const LIVE = new Set(['running', 'paused']);

export class Ingest {
  private poller = new RssPoller();
  private recentTitles: string[] = [];

  constructor(private ctx: EngineCtx) {}

  /** Union of default feeds, engine extras and every live session's seed.yaml feeds. */
  feeds(): string[] {
    const ids = new Set<string>([...DEFAULT_FEED_IDS, ...config.feeds.extra]);
    const live = new Set<bigint>();
    for (const s of this.ctx.conn.db.session.iter()) if (LIVE.has(s.status)) live.add(s.id);
    for (const f of this.ctx.conn.db.seedFile.iter()) {
      if (f.path !== 'seed.yaml' || !live.has(f.sessionId)) continue;
      try {
        for (const id of parseSeedYaml(f.content).feeds) ids.add(id);
      } catch {
        /* malformed seed.yaml: ignore its feeds */
      }
    }
    return [...ids];
  }

  async pollOnce(): Promise<number> {
    if (this.ctx.hub.watched().size === 0) return 0; // nothing to trade, nothing to read
    const items = await this.poller.poll(this.feeds());
    return this.accept(items);
  }

  /** Accept items from RSS, the HTTP API or Telegram. Returns the number queued. */
  async accept(items: FeedItem[]): Promise<number> {
    const maxAge = config.feeds.maxAgeMin * 60_000;
    const fresh: (FeedItem & { hash: string; urgency: number })[] = [];
    for (const it of items) {
      if (Date.now() - it.publishedMs > maxAge) continue;
      const hash = newsHash(it.title, it.url);
      if (byUnique(this.ctx.conn.db.newsItem.hash, hash)) continue;
      if (fresh.some(f => f.hash === hash)) continue;
      // the same story from another outlet is not new information
      if (this.recentTitles.some(t => isNearDuplicate(t, it.title))) continue;
      fresh.push({ ...it, hash, urgency: regexUrgency(`${it.title} ${it.summary}`) });
    }
    if (fresh.length === 0) return 0;
    this.recentTitles.push(...fresh.map(f => f.title));
    if (this.recentTitles.length > 400) this.recentTitles.splice(0, this.recentTitles.length - 400);

    await this.ctx.conn.reducers.insertNews({
      items: fresh.map(f => ({
        hash: f.hash,
        source: f.source,
        feed: f.feed,
        title: truncate(f.title, 480),
        summary: truncate(f.summary, 3800),
        url: f.url,
        publishedAt: tsFromMs(Math.min(f.publishedMs, Date.now())),
        urgency: f.urgency,
      })),
    });
    // urgent headlines jump the queue
    await this.ctx.conn.reducers.enqueueTasks({
      tasks: fresh.map(f => ({
        kind: 'triage',
        sessionId: 0n,
        priority: Math.round(100 * f.urgency) + 10,
        dependsOn: [],
        dedupeKey: `triage:${f.hash}`,
        payload: JSON.stringify({ hash: f.hash }),
        maxAttempts: 3,
        notBeforeMicros: 0n,
      })),
    });
    log.info('queued news', { n: fresh.length, top: truncate(fresh.sort((a, b) => b.urgency - a.urgency)[0].title, 90) });
    return fresh.length;
  }
}

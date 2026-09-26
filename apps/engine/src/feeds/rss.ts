// RSS/Atom ingestion with conditional GETs. Feed ids like "bloomberg:markets"
// resolve through the registry; anything starting with http is used as is.
// URLs verified live on 2026-09-26 (see docs/RESEARCH.md → feeds).
import { XMLParser } from 'fast-xml-parser';
import { config } from '../config';
import { logger } from '../log';

const log = logger('rss');

export const FEED_REGISTRY: Record<string, string> = {
  'bloomberg:markets': 'https://www.bloomberg.com/feeds/markets/news.rss',
  'bloomberg:politics': 'https://www.bloomberg.com/feeds/politics/news.rss',
  'bloomberg:technology': 'https://www.bloomberg.com/feeds/technology/news.rss',
  'bloomberg:economics': 'https://www.bloomberg.com/feeds/economics/news.rss',
  'bloomberg:industries': 'https://www.bloomberg.com/feeds/industries/news.rss',
  'bloomberg:opinion': 'https://www.bloomberg.com/feeds/bview/news.rss',
  'bloomberg:businessweek': 'https://www.bloomberg.com/feeds/businessweek/news.rss',
  'cnbc:top': 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114',
  'cnbc:finance': 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664',
  'cnbc:markets': 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258',
  'wsj:markets': 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
  'marketwatch:top': 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
  'fed:press': 'https://www.federalreserve.gov/feeds/press_all.xml',
  'fed:monetary': 'https://www.federalreserve.gov/feeds/press_monetary.xml',
  'fed:speeches': 'https://www.federalreserve.gov/feeds/speeches.xml',
  'sec:press': 'https://www.sec.gov/news/pressreleases.rss',
  'ecb:press': 'https://www.ecb.europa.eu/rss/press.html',
  'boe:news': 'https://www.bankofengland.co.uk/rss/news',
  'coindesk': 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'cointelegraph': 'https://cointelegraph.com/rss',
  'theblock': 'https://www.theblock.co/rss.xml',
  'yahoo:finance': 'https://finance.yahoo.com/news/rssindex',
  'bbc:business': 'https://feeds.bbci.co.uk/news/business/rss.xml',
  'bbc:world': 'https://feeds.bbci.co.uk/news/world/rss.xml',
  'ft:home': 'https://www.ft.com/rss/home',
  'ft:markets': 'https://www.ft.com/markets?format=rss',
  'nyt:business': 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml',
  'guardian:business': 'https://www.theguardian.com/business/rss',
  'economist:finance': 'https://www.economist.com/finance-and-economics/rss.xml',
  'nasdaq:markets': 'https://www.nasdaq.com/feed/rssoutbound?category=Markets',
};

export const DEFAULT_FEED_IDS = [
  'bloomberg:markets',
  'bloomberg:politics',
  'bloomberg:economics',
  'bloomberg:technology',
  'cnbc:top',
  'wsj:markets',
  'fed:press',
  'bbc:world',
];

export function resolveFeed(id: string): { id: string; url: string } | undefined {
  if (/^https?:\/\//.test(id)) return { id: new URL(id).hostname, url: id };
  const url = FEED_REGISTRY[id];
  return url ? { id, url } : undefined;
}

export interface FeedItem {
  feed: string;
  source: string;
  title: string;
  summary: string;
  url: string;
  publishedMs: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  trimValues: true,
});

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  const o = v as Record<string, unknown>;
  return text(o['#cdata'] ?? o['#text'] ?? o['@href'] ?? '');
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export function parseFeed(xml: string, feedId: string): FeedItem[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const source = feedId.split(':')[0];
  const out: FeedItem[] = [];
  const rssItems = asArray(doc?.rss?.channel?.item ?? doc?.['rdf:RDF']?.item);
  for (const it of rssItems) {
    const title = stripHtml(text(it.title));
    if (!title) continue;
    const link = text(it.link) || text(it.guid);
    const date = Date.parse(text(it.pubDate) || text(it['dc:date']) || '');
    out.push({
      feed: feedId,
      source,
      title,
      summary: stripHtml(text(it.description) || text(it['content:encoded'])).slice(0, 1500),
      url: link,
      publishedMs: Number.isFinite(date) ? date : Date.now(),
    });
  }
  for (const e of asArray(doc?.feed?.entry)) {
    const title = stripHtml(text(e.title));
    if (!title) continue;
    const links = asArray(e.link) as Record<string, unknown>[];
    const link = text(links.find(l => (l['@rel'] ?? 'alternate') === 'alternate')?.['@href'] ?? links[0]);
    const date = Date.parse(text(e.updated) || text(e.published) || '');
    out.push({
      feed: feedId,
      source,
      title,
      summary: stripHtml(text(e.summary) || text(e.content)).slice(0, 1500),
      url: link,
      publishedMs: Number.isFinite(date) ? date : Date.now(),
    });
  }
  return out;
}

interface FeedState {
  etag?: string;
  lastModified?: string;
  failures: number;
  nextPollMs: number;
}

/** Polls feeds politely (conditional GET, per-feed backoff on errors). */
export class RssPoller {
  private state = new Map<string, FeedState>();

  async poll(feedIds: string[]): Promise<FeedItem[]> {
    const now = Date.now();
    const feeds = [...new Set(feedIds)].map(resolveFeed).filter((f): f is { id: string; url: string } => Boolean(f));
    const results = await Promise.all(
      feeds.map(async f => {
        const st = this.state.get(f.url) ?? { failures: 0, nextPollMs: 0 };
        if (st.nextPollMs > now) return [];
        try {
          const headers: Record<string, string> = {
            'User-Agent': f.url.includes('sec.gov') ? 'MIDAS research contact@example.com' : config.feeds.userAgent,
            Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
          };
          if (st.etag) headers['If-None-Match'] = st.etag;
          if (st.lastModified) headers['If-Modified-Since'] = st.lastModified;
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 12_000);
          const res = await fetch(f.url, { headers, redirect: 'follow', signal: ctrl.signal }).finally(() => clearTimeout(timer));
          if (res.status === 304) {
            this.state.set(f.url, { ...st, failures: 0, nextPollMs: now + config.feeds.pollSec * 1000 });
            return [];
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const xml = await res.text();
          this.state.set(f.url, {
            etag: res.headers.get('etag') ?? undefined,
            lastModified: res.headers.get('last-modified') ?? undefined,
            failures: 0,
            nextPollMs: now + config.feeds.pollSec * 1000,
          });
          return parseFeed(xml, f.id);
        } catch (err) {
          const failures = st.failures + 1;
          const backoff = Math.min(30 * 60_000, config.feeds.pollSec * 1000 * 2 ** failures);
          this.state.set(f.url, { ...st, failures, nextPollMs: now + backoff });
          if (failures <= 2 || failures % 10 === 0) log.warn('feed failed', { feed: f.id, failures, err: String(err) });
          return [];
        }
      })
    );
    return results.flat();
  }
}

import { describe, expect, it } from 'vitest';
import { parseFeed, resolveFeed } from '../src/feeds/rss';
import { fromGamma, roundToTick } from '../src/venues/polymarket';
import { toWireQuestion } from '../src/s1/systemone';
import { DEFAULT_REFLEXES } from '@midas/core';
import { keyedMutex, sleep } from '../src/util/async';

describe('RSS/Atom parsing', () => {
  it('parses RSS 2.0 with CDATA and HTML', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
      <item><title><![CDATA[Fed holds rates <b>steady</b>]]></title><link>https://ex.com/a</link>
      <description><![CDATA[<p>Powell &amp; co. signal patience</p>]]></description><pubDate>Fri, 26 Sep 2026 13:00:00 GMT</pubDate></item>
      <item><title>Second</title><link>https://ex.com/b</link></item></channel></rss>`;
    const items = parseFeed(xml, 'bloomberg:markets');
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Fed holds rates steady');
    expect(items[0].summary).toBe('Powell & co. signal patience');
    expect(items[0].publishedMs).toBe(Date.parse('2026-09-26T13:00:00Z'));
    expect(items[0].source).toBe('bloomberg');
  });

  it('parses Atom entries', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>8-K filed</title>
      <link rel="alternate" href="https://sec.gov/x"/><updated>2026-09-26T12:00:00Z</updated><summary>text</summary></entry></feed>`;
    const items = parseFeed(xml, 'sec:press');
    expect(items[0].url).toBe('https://sec.gov/x');
    expect(items[0].publishedMs).toBe(Date.parse('2026-09-26T12:00:00Z'));
  });

  it('resolves registry ids and raw URLs', () => {
    expect(resolveFeed('bloomberg:markets')?.url).toContain('bloomberg.com/feeds/markets');
    expect(resolveFeed('https://example.com/rss.xml')?.id).toBe('example.com');
    expect(resolveFeed('nope:nope')).toBeUndefined();
  });
});

describe('Polymarket mapping', () => {
  it('parses Gamma JSON-string fields and fee schedule', () => {
    const m = fromGamma({
      conditionId: '0xabc',
      id: '1',
      question: 'Q?',
      slug: 'q',
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.62", "0.38"]',
      clobTokenIds: '["111", "222"]',
      orderPriceMinTickSize: 0.01,
      orderMinSize: 5,
      negRisk: false,
      active: true,
      closed: false,
      feesEnabled: true,
      feeSchedule: { rate: 0.04, exponent: 1, takerOnly: true },
      bestBid: 0.61,
      bestAsk: 0.63,
      volume24hr: 1000,
      liquidityNum: 5000,
    })!;
    expect(m.yesTokenId).toBe('111');
    expect(m.noTokenId).toBe('222');
    expect(m.feeRate).toBe(0.04);
    expect(m.lastPrice).toBeCloseTo(0.62);
    expect(m.volumeDay).toBe(1000);
    expect(m.resolvedYes).toBeUndefined();
  });

  it('detects resolution from closed markets', () => {
    const m = fromGamma({ conditionId: '0x1', outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', clobTokenIds: '["1","2"]', closed: true })!;
    expect(m.resolvedYes).toBe(1);
    expect(m.active).toBe(false);
  });

  it('rounds prices to the tick in the safe direction', () => {
    expect(roundToTick(0.6349, 0.01, 'BUY')).toBe(0.63);
    expect(roundToTick(0.6301, 0.01, 'SELL')).toBe(0.64);
    expect(roundToTick(0.001, 0.01, 'BUY')).toBe(0.01);
  });
});

describe('System-One wire protocol', () => {
  it('maps reflex definitions to Jev/Laya questions', () => {
    const dir = DEFAULT_REFLEXES.find(r => r.key === 'news.direction')!;
    const q = toWireQuestion(dir);
    expect(q.type).toBe('choice');
    expect(Object.keys((q as { criteria: Record<string, string> }).criteria)).toEqual(['up', 'down', 'none']);
    const urg = toWireQuestion(DEFAULT_REFLEXES.find(r => r.key === 'news.urgency')!);
    expect(urg.type).toBe('score');
    expect((urg as { criteria: string[] }).criteria).toHaveLength(4);
  });
});

describe('keyedMutex', () => {
  it('serializes one key, runs other keys in parallel, and survives failures', async () => {
    const lock = keyedMutex();
    const log: string[] = [];
    const job = (key: string, name: string, ms: number, fail = false) =>
      lock(key, async () => {
        log.push(`${name}+`);
        await sleep(ms);
        log.push(`${name}-`);
        if (fail) throw new Error(name);
        return name;
      });
    const a1 = job('s1', 'a1', 30, true);
    const a2 = job('s1', 'a2', 5);
    const b1 = job('s2', 'b1', 10);
    await expect(a1).rejects.toThrow('a1');
    expect(await a2).toBe('a2');
    expect(await b1).toBe('b1');
    // b1 ran while a1 held s1; a2 waited for a1 even though a1 failed
    expect(log.indexOf('b1+')).toBeLessThan(log.indexOf('a1-'));
    expect(log.indexOf('a2+')).toBeGreaterThan(log.indexOf('a1-'));
  });
});

// Cheap text machinery: stable hashing, near-duplicate detection, and regex
// "vibe" triage. None of this needs a model; it runs on every headline.

/** FNV-1a 64-bit as hex. Stable across processes (used for news dedupe). */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[-–—|]\s*(bloomberg|reuters|cnbc|wsj|ft|ap|marketwatch)\s*$/i, '')
    .replace(/[^a-z0-9%$.]+/g, ' ')
    .trim();
}

export function newsHash(title: string, url: string): string {
  return fnv1a64(`${normalizeTitle(title)}|${url.split('?')[0]}`);
}

const STOP = new Set(
  'a an the of to in on for and or but with at by from as is are was were be been it its this that after over into up down says said amid new'.split(
    ' '
  )
);

export function tokens(text: string): string[] {
  return normalizeTitle(text)
    .split(' ')
    .filter(t => t.length > 1 && !STOP.has(t));
}

/** 64-bit SimHash over word bigrams + unigrams. */
export function simhash64(text: string): bigint {
  const toks = tokens(text);
  const feats = [...toks, ...toks.slice(1).map((t, i) => `${toks[i]}_${t}`)];
  const v = new Array<number>(64).fill(0);
  for (const f of feats) {
    const h = BigInt(`0x${fnv1a64(f)}`);
    for (let i = 0; i < 64; i++) v[i] += (h >> BigInt(i)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if (v[i] > 0) out |= 1n << BigInt(i);
  return out;
}

export function hamming64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let c = 0;
  while (x) {
    x &= x - 1n;
    c++;
  }
  return c;
}

export function jaccard(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Same story re-published by another outlet / with a tweaked headline.
 * Headlines are short, so SimHash alone is noisy; token Jaccard catches the
 * one-word edits, SimHash the reorderings of longer texts.
 */
export function isNearDuplicate(a: string, b: string, minJaccard = 0.7, maxBits = 6): boolean {
  return jaccard(a, b) >= minJaccard || hamming64(simhash64(a), simhash64(b)) <= maxBits;
}

const URGENT: [RegExp, number][] = [
  [/\b(breaking|just in|flash|urgent|alert)\b/i, 0.35],
  [/\b(resign(s|ed)?|ousted|fired|impeach(ed|ment)?|indicted|arrested|dies|dead|killed|assassinat)/i, 0.5],
  [/\b(surge[sd]?|plunge[sd]?|soar(s|ed)?|crash(es|ed)?|tumble[sd]?|spike[sd]?|collapse[sd]?)\b/i, 0.35],
  [/\b(approve[sd]?|reject(s|ed)?|ban(s|ned)?|block(s|ed)?|veto(es|ed)?|sanction(s|ed)?|halt(s|ed)?)\b/i, 0.3],
  [/\b(rate (cut|hike)|cuts rates|raises rates|emergency|default(s|ed)?|bankrupt(cy)?|recession)\b/i, 0.45],
  [/\b(wins?|won|concede[sd]?|declares? victory|called for|projected)\b/i, 0.35],
  [/\b(ceasefire|invade[sd]?|invasion|strike[sd]?|attack(s|ed)?|missile|war)\b/i, 0.4],
  [/\b(ruling|verdict|supreme court|guilty|acquitted)\b/i, 0.35],
  [/\b(beats?|misses?|guidance|earnings|jobs report|cpi|inflation)\b/i, 0.25],
];

/** Regex urgency in [0,1]: fast, free, and good enough to order the queue. */
export function regexUrgency(text: string): number {
  let u = 0;
  for (const [re, w] of URGENT) if (re.test(text)) u = 1 - (1 - u) * (1 - w);
  return Math.min(1, u);
}

/** Case-insensitive whole-word keyword hits. */
export function keywordHits(text: string, keywords: string[]): string[] {
  const hay = ` ${normalizeTitle(text)} `;
  const hits: string[] = [];
  for (const k of keywords) {
    const needle = normalizeTitle(k);
    if (needle && hay.includes(` ${needle} `)) hits.push(k);
  }
  return hits;
}

/** Capitalized multi-word spans — a crude entity candidate extractor for fallbacks. */
export function candidateEntities(text: string, max = 8): string[] {
  const out = new Set<string>();
  const re = /\b([A-Z][a-zA-Z.&'-]+(?:\s+(?:of|the|de|and|&)?\s*[A-Z][a-zA-Z.&'-]+)*)/g;
  for (const m of text.matchAll(re)) {
    const s = m[1].trim();
    if (s.length > 2 && !/^(The|A|An|In|On|At|After|Before|Why|How|What)$/.test(s)) out.add(s);
    if (out.size >= max) break;
  }
  return [...out];
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// The LLM wiki (Karpathy pattern) for each session's seed folder:
//   raw/ is immutable input, wiki/ is compiled and kept current by agents,
//   index.md catalogs pages, log.md is an append-only timeline.
// Lint before compile: a System-1 `wiki.stale` reflex checks every market page
// against new facts in parallel; only stale pages get a (Flash) rewrite.
import { slugify } from '@midas/core';
import type { Market, SeedFile, Session } from '@midas/stdb-bindings/types';
import type { EngineCtx } from '../ctx';
import { geminiAvailable, generateJson } from '../llm/gemini';
import { WIKI_SCHEMA, WIKI_SYSTEM, type WikiOut } from '../llm/prompts';
import { logger } from '../log';
import { msFromTs } from '../util/time';
import { UsageSum, type Handler } from '../ledger/types';

const log = logger('wiki');

function files(ctx: EngineCtx, sessionId: bigint): SeedFile[] {
  return [...ctx.conn.db.seedFile.sessionId.filter(sessionId)];
}

function pagePath(m: Market): string {
  return `wiki/markets/${slugify(m.slug || m.question || m.conditionId)}.md`;
}

/** New facts about a market since `sinceMs`, with citable ids. */
function factsFor(ctx: EngineCtx, s: Session, m: Market, sinceMs: number): string[] {
  const facts: string[] = [];
  const px = ctx.hub.price(m.conditionId);
  if (px) facts.push(`Current price ${px.mid.toFixed(3)} (bid ${px.bid.toFixed(3)} / ask ${px.ask.toFixed(3)}).`);
  for (const sig of ctx.conn.db.signal.conditionId.filter(m.conditionId)) {
    if (msFromTs(sig.createdAt) < sinceMs) continue;
    const news = ctx.conn.db.newsItem.id.find(sig.newsId);
    facts.push(
      `[news:${sig.newsId}] "${news?.title ?? ''}" → ${sig.layer} forecast: move ${(100 * sig.expectedDelta).toFixed(1)} pts, fair ${sig.probYes.toFixed(2)}${sig.realizedLong !== undefined ? `, realized ${(100 * sig.realizedLong).toFixed(1)} pts` : ''}. ${sig.rationale.slice(0, 300)}`
    );
  }
  for (const d of ctx.conn.db.decision.sessionId.filter(s.id)) {
    if (d.conditionId !== m.conditionId || msFromTs(d.createdAt) < sinceMs || d.verdict !== 'approved') continue;
    facts.push(`[trade:${d.ref}] ${d.action} ${d.strategy} $${d.sizeUsd.toFixed(2)} at ${d.marketPrice.toFixed(3)} (edge ${(100 * d.edge).toFixed(1)} pts).`);
  }
  return facts.slice(-25);
}

async function writeFile(ctx: EngineCtx, s: Session, path: string, content: string) {
  await ctx.conn.reducers.upsertSeedFile({ sessionId: s.id, file: { path, kind: 'wiki', content } });
}

function appendLog(existing: string | undefined, entries: string[]): string {
  const base = existing ?? '# Log\n';
  return `${base.trimEnd()}\n${entries.join('\n')}\n`;
}

export const compileWiki: Handler = async (ctx, _task, p: { sessionId: string }) => {
  const s = ctx.conn.db.session.id.find(BigInt(p.sessionId));
  if (!s || s.status === 'archived') return { result: { skipped: 'no session' } };
  const usage = new UsageSum();
  const all = files(ctx, s.id);
  const byPath = new Map(all.map(f => [f.path, f]));
  const markets = [...ctx.conn.db.sessionMarket.sessionId.filter(s.id)]
    .map(sm => ctx.hub.market(sm.conditionId))
    .filter((m): m is Market => Boolean(m));

  const logEntries: string[] = [];
  const touched: string[] = [];
  const candidates = markets
    .map(m => {
      const path = pagePath(m);
      const page = byPath.get(path);
      const since = page ? msFromTs(page.updatedAt) : 0;
      return { m, path, page, facts: factsFor(ctx, s, m, since) };
    })
    .filter(x => !x.page || x.facts.length > 1);

  // lint: which existing pages are actually stale? (System 1, in parallel)
  const lint = await ctx.reflexes.fireMany(
    ['wiki.stale'],
    candidates
      .filter(x => x.page)
      .map(x => ({ refId: `wiki:${s.id}:${x.path}`, state: { text: `PAGE:\n${x.page!.content.slice(0, 3000)}\n\nNEW FACTS:\n${x.facts.join('\n')}` } }))
  );
  let li = 0;
  for (const x of candidates) {
    const stale = x.page ? lint[li++]?.['wiki.stale']?.fire ?? true : true;
    if (!stale) continue;
    if (!geminiAvailable()) {
      if (!x.page) await writeFile(ctx, s, x.path, `# ${x.m.question}\n\n${x.m.description.slice(0, 1500)}\n\n## Recent\n${x.facts.map(f => `- ${f}`).join('\n')}\n`);
      continue;
    }
    try {
      const r = await generateJson<WikiOut>({
        route: 'wiki',
        tier: 'flash',
        system: WIKI_SYSTEM,
        prefix: `PAGE PATH: ${x.path}\nMARKET: ${x.m.question}\nRESOLUTION: ${x.m.description.slice(0, 1500)}\nENDS: ${x.m.endDate}\n\nCURRENT PAGE:\n${x.page?.content ?? '(empty — create it: question, resolution criteria, current fair value and reasoning, drivers, what would change our mind, recent signals)'}`,
        suffix: `NEW FACTS:\n${x.facts.join('\n') || '(none)'}\n\nSESSION THESIS: ${s.thesis.slice(0, 800)}`,
        schema: WIKI_SCHEMA,
        thinking: 'low',
        sessionId: s.id,
      });
      usage.add(r);
      await writeFile(ctx, s, x.path, r.data.content);
      touched.push(x.path);
      logEntries.push(`## [${new Date().toISOString().slice(0, 16).replace('T', ' ')}] compile | ${x.path}\n${r.data.changeSummary}`);
    } catch (err) {
      log.warn('page compile failed', { path: x.path, err: String(err) });
    }
  }

  // index.md is deterministic: one line per page
  const pages = files(ctx, s.id)
    .filter(f => f.path.startsWith('wiki/') && f.path !== 'wiki/index.md' && f.path !== 'wiki/log.md')
    .sort((a, b) => a.path.localeCompare(b.path));
  const index = [
    '# Index',
    '',
    '## Markets',
    ...pages.filter(f => f.path.startsWith('wiki/markets/')).map(f => `- [[${f.path.replace(/^wiki\//, '').replace(/\.md$/, '')}]] — ${f.content.split('\n')[0].replace(/^#\s*/, '').slice(0, 120)}`),
    '',
    '## Entities',
    ...(pages.filter(f => f.path.startsWith('wiki/entities/')).map(f => `- [[${f.path.replace(/^wiki\//, '').replace(/\.md$/, '')}]]`) || []),
    '',
    '## Lessons',
    '- [[lessons]] — distilled lessons from resolved predictions',
    '',
  ].join('\n');
  if (byPath.get('wiki/index.md')?.content !== index) await writeFile(ctx, s, 'wiki/index.md', index);
  if (logEntries.length) await writeFile(ctx, s, 'wiki/log.md', appendLog(byPath.get('wiki/log.md')?.content, logEntries));
  return { result: { touched }, usage: usage.get() };
};

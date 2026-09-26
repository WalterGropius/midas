// Reflexion: a big miss becomes (at most) one durable lesson — pattern →
// rule — stored in graph memory next to the entities and market it concerns,
// and appended to the sessions' wiki/lessons.md. Lessons are retrieved into
// future prompts and earn helpful/harmful credit from later outcomes.
import { fnv1a64 } from '@midas/core';
import type { EngineCtx } from '../ctx';
import { geminiAvailable, generateJson } from '../llm/gemini';
import { REFLECT_SCHEMA, REFLECT_SYSTEM, type ReflectOut } from '../llm/prompts';
import { logger } from '../log';
import { keys } from '../memory/graph';
import { marketBlock, newsBlock, sessionsForMarket, TRADING } from '../intel/common';
import { UsageSum, type Handler } from '../ledger/types';
import { byUnique } from '../util/rows';

const log = logger('reflect');

export const reflect: Handler = async (ctx, _task, p: { signalRef: string; realized: number }) => {
  if (!geminiAvailable()) return { result: { skipped: 'no model' } };
  const sig = byUnique(ctx.conn.db.signal.ref, p.signalRef);
  const news = sig && ctx.conn.db.newsItem.id.find(sig.newsId);
  const market = sig && ctx.hub.market(sig.conditionId);
  if (!sig || !news || !market) return { result: { skipped: 'missing rows' } };
  const usage = new UsageSum();
  const r = await generateJson<ReflectOut>({
    route: 'reflect',
    tier: 'flash',
    system: REFLECT_SYSTEM,
    prefix: `${marketBlock(market)}\n\n${newsBlock(news)}`,
    suffix: `FORECAST (${sig.layer}): expected move ${(100 * sig.expectedDelta).toFixed(1)} points (10–90%: ${(100 * sig.deltaQ10).toFixed(1)} to ${(100 * sig.deltaQ90).toFixed(1)}), half-life ${sig.halfLifeMin.toFixed(0)} min, fair value ${sig.probYes.toFixed(2)}.\nREASONING: ${sig.rationale}\n\nWHAT HAPPENED: the price moved ${(100 * p.realized).toFixed(1)} points over the next 2 hours (from ${sig.probMarket.toFixed(3)}).`,
    schema: REFLECT_SCHEMA,
    thinking: 'medium',
  });
  usage.add(r);
  const lesson = r.data.lesson;
  if (!lesson) return { result: { lesson: null, errorKind: r.data.errorKind }, usage: usage.get() };

  const lessonKey = keys.lesson(`${lesson.pattern.slice(0, 60)}-${fnv1a64(lesson.pattern).slice(0, 6)}`);
  await ctx.graph.upsertNodes([
    { key: lessonKey, kind: 'lesson', label: lesson.pattern.slice(0, 280), summary: lesson.rule, status: 'draft', salienceDelta: 1 },
  ]);
  const targets = [keys.market(market.conditionId), keys.event(news.id), ...lesson.appliesTo.slice(0, 6).map(n => keys.entity(n))];
  await ctx.graph.upsertNodes(lesson.appliesTo.slice(0, 6).map(n => ({ key: keys.entity(n), kind: 'entity', label: n, salienceDelta: 0.2 })));
  await ctx.graph.upsertEdges([
    ...targets.map(t => ({ srcKey: lessonKey, dstKey: t, rel: t.startsWith('event:') ? 'learned_from' : 'lesson_for', evidence: `signal:${sig.ref}` })),
  ]);
  // append to every watching session's wiki/lessons.md
  for (const s of sessionsForMarket(ctx, market.conditionId, new Set([...TRADING, 'paused']))) {
    const file = [...ctx.conn.db.seedFile.sessionId.filter(s.id)].find(f => f.path === 'wiki/lessons.md');
    const entry = `\n## ${lesson.pattern}\n- **Rule:** ${lesson.rule}\n- **Evidence:** [news:${news.id}] predicted ${(100 * sig.expectedDelta).toFixed(1)} pts, realized ${(100 * p.realized).toFixed(1)} pts (${r.data.errorKind} error)\n- **Applies to:** ${lesson.appliesTo.join(', ') || 'general'}\n`;
    await ctx.conn.reducers.upsertSeedFile({
      sessionId: s.id,
      file: { path: 'wiki/lessons.md', kind: 'wiki', content: `${(file?.content ?? '# Lessons\n').replace('_None yet. Lessons are distilled from resolved predictions._\n', '')}${entry}` },
    });
  }
  ctx.activity({ sessionId: 0n, level: 'info', kind: 'lesson', message: `lesson: ${lesson.pattern} → ${lesson.rule}`.slice(0, 500), refId: sig.ref });
  await ctx.alerts.send('lesson', `New lesson: ${lesson.pattern}\n→ ${lesson.rule}`);
  log.info('lesson', { key: lessonKey, kind: r.data.errorKind });
  return { result: { lessonKey, errorKind: r.data.errorKind }, usage: usage.get() };
};

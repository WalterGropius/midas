// Triage: one headline × every watched market.
//
//   1. System-1 reflexes, fanned out in parallel over all (headline, market)
//      pairs: relevance, direction, urgency (+ novelty once per headline).
//   2. Only if something is relevant: one Flash call extracts entities and
//      event type, the headline is embedded, and the graph is updated.
//   3. Per relevant market: a swarm task, and — if the reflexes are confident
//      and fast money is on the table — a reflex quick-trade decision that
//      does not wait for the swarm.
import { deltaFromShift, regexUrgency } from '@midas/core';
import type { Market, NewsItem } from '@midas/stdb-bindings/types';
import { config } from '../config';
import type { EngineCtx } from '../ctx';
import { embed, geminiAvailable, generateJson } from '../llm/gemini';
import { TRIAGE_SCHEMA, TRIAGE_SYSTEM, type TriageOut } from '../llm/prompts';
import { logger } from '../log';
import { keys } from '../memory/graph';
import { task, UsageSum, type Handler, type TaskInput } from '../ledger/types';
import { ref, msFromTs } from '../util/time';
import { recentHeadlines, sessionsForMarket } from './common';
import { byUnique } from '../util/rows';

const log = logger('triage');

function pairState(n: NewsItem, m: Market) {
  return {
    text: `HEADLINE: ${n.title}\nSUMMARY: ${n.summary.slice(0, 600)}\nMARKET: ${m.question}\nRULES: ${m.description.slice(0, 600)}`,
    payload: {
      headline: n.title,
      summary: n.summary.slice(0, 600),
      source: n.source,
      market_question: m.question,
      market_rules: m.description.slice(0, 600),
      market_ends: m.endDate,
    },
    features: { headline: n.title, question: m.question },
  };
}

export const triage: Handler = async (ctx, _task, payload: { hash: string }) => {
  const news = byUnique(ctx.conn.db.newsItem.hash, payload.hash);
  if (!news) return { result: { skipped: 'news row missing' } };
  const markets = [...ctx.hub.watched()]
    .map(id => ctx.hub.market(id))
    .filter((m): m is Market => Boolean(m) && m!.active && !m!.resolved);
  if (markets.length === 0) return { result: { skipped: 'no active markets' } };
  const usage = new UsageSum();

  // ── 1. reflexes over every pair (the for-each loop System 1 is built for)
  const firings = await ctx.reflexes.fireMany(
    ['news.relevance', 'news.direction', 'news.urgency'],
    markets.map(m => ({ state: pairState(news, m), refId: `news:${news.id}|${m.conditionId}` }))
  );
  const novelty = await ctx.reflexes
    .fire(
      ['news.novelty'],
      {
        text: `NEW: ${news.title}\nRECENT:\n${recentHeadlines(ctx, msFromTs(news.publishedAt)).join('\n')}`,
        features: { headline: news.title, recent: recentHeadlines(ctx, msFromTs(news.publishedAt)) },
      },
      `news:${news.id}`
    )
    .catch(() => undefined);
  const isNovel = novelty?.['news.novelty']?.fire ?? true;

  const relevant = markets
    .map((m, i) => ({ m, f: firings[i] }))
    .filter(x => x.f?.['news.relevance']?.fire);

  if (relevant.length === 0 || !isNovel) {
    await ctx.conn.reducers.updateNewsTriage({
      updates: [
        {
          newsId: news.id,
          status: 'irrelevant',
          urgency: news.urgency,
          sentiment: 0,
          novelty: novelty?.['news.novelty']?.prob ?? 0,
          eventType: '',
          entities: [],
          marketIds: [],
          triageNote: isNovel ? 'no market relevant (System 1)' : 'not new information (System 1)',
        },
      ],
    });
    return { result: { relevant: 0, novel: isNovel } };
  }

  // ── 2. structured extraction (one Flash call) + embedding + graph
  let extraction: TriageOut['items'][number] | undefined;
  if (geminiAvailable()) {
    try {
      const r = await generateJson<TriageOut>({
        route: 'triage',
        tier: 'flash',
        system: TRIAGE_SYSTEM,
        prefix: `CANDIDATE MARKETS:\n${relevant.map(x => `- id=${x.m.conditionId} :: ${x.m.question}`).join('\n')}`,
        suffix: `NEWS ITEMS:\n[0] ${news.title}\n${news.summary.slice(0, 1200)}`,
        schema: TRIAGE_SCHEMA,
        thinking: 'low',
      });
      usage.add(r);
      extraction = r.data.items?.find(i => i.index === 0) ?? r.data.items?.[0];
    } catch (err) {
      log.warn('extraction failed; continuing with reflexes only', { news: news.id, err: String(err) });
    }
  }
  const entities = (extraction?.entities ?? []).filter(e => e.name && e.name.length < 120).slice(0, 12);
  let embedding: number[] | undefined;
  if (geminiAvailable()) {
    try {
      [embedding] = await embed([`${news.title}. ${news.summary.slice(0, 400)}`]);
    } catch (err) {
      log.debug('embed failed', { err: String(err) });
    }
  }

  const eventKey = keys.event(news.id);
  await ctx.graph.upsertNodes([
    {
      key: eventKey,
      kind: 'event',
      label: news.title,
      summary: extraction?.summary ?? news.summary.slice(0, 300),
      status: 'canonical',
      embedding,
    },
    ...entities.map(e => ({ key: keys.entity(e.name), kind: 'entity', label: e.name, aliases: [e.name], summary: e.kind })),
    ...relevant.map(x => ({ key: keys.market(x.m.conditionId), kind: 'market', label: x.m.question, status: 'canonical', salienceDelta: 0.2 })),
  ]);
  await ctx.graph.upsertEdges([
    ...entities.map(e => ({ srcKey: eventKey, dstKey: keys.entity(e.name), rel: 'mentions', evidence: `news:${news.id}`, status: 'canonical' })),
    ...relevant.map(x => ({
      srcKey: eventKey,
      dstKey: keys.market(x.m.conditionId),
      rel: 'about',
      weight: x.f?.['news.relevance']?.prob ?? 0.5,
      evidence: `news:${news.id}`,
    })),
    ...relevant.flatMap(x =>
      entities.slice(0, 5).map(e => ({ srcKey: keys.entity(e.name), dstKey: keys.market(x.m.conditionId), rel: 'related', weight: 0.5, evidence: `news:${news.id}` }))
    ),
  ]);

  const urgency = Math.max(
    news.urgency,
    regexUrgency(news.title),
    ...relevant.map(x => x.f?.['news.urgency']?.prob ?? 0)
  );
  await ctx.conn.reducers.updateNewsTriage({
    updates: [
      {
        newsId: news.id,
        status: 'escalated',
        urgency,
        sentiment: extraction?.sentiment ?? 0,
        novelty: extraction?.novelty ?? novelty?.['news.novelty']?.prob ?? 0.5,
        eventType: extraction?.eventType ?? '',
        entities: entities.map(e => e.name),
        marketIds: relevant.map(x => x.m.conditionId),
        triageNote: extraction?.summary ?? '',
      },
    ],
  });

  // ── 3. swarm tasks, plus reflex quick-trades where the reflexes are sure
  const followups: TaskInput[] = [];
  for (const { m, f } of relevant) {
    const direction = f?.['news.direction'];
    const urg = f?.['news.urgency'];
    const upP = direction?.answer.probs?.up ?? (direction?.answer.choice === 'up' ? direction.prob : 0);
    const downP = direction?.answer.probs?.down ?? (direction?.answer.choice === 'down' ? direction.prob : 0);
    followups.push(
      task(
        'swarm',
        `swarm:${news.id}:${m.conditionId}`,
        {
          newsId: news.id.toString(),
          conditionId: m.conditionId,
          relevance: f?.['news.relevance']?.prob,
          upP,
          downP,
          urgency: urg?.prob,
          entityKeys: entities.map(e => keys.entity(e.name)),
        },
        { priority: Math.round(100 * urgency), maxAttempts: 2 }
      )
    );
    // Reflex quick-trade: act on System 1 when the move is likely fast and
    // one-sided; deliberation later confirms, scales, or exits.
    const reflexDir = upP >= 0.75 ? 1 : downP >= 0.75 ? -1 : 0;
    if (config.intel.reflexTrades && reflexDir !== 0 && (urg?.prob ?? 0) >= 0.66) {
      const price = ctx.hub.price(m.conditionId);
      if (!price) continue;
      // strength scale from urgency: material ≈ 0.3, decisive ≈ 0.7 log-odds
      const shift = reflexDir * (0.3 + 0.4 * Math.max(0, ((urg?.prob ?? 0) - 0.66) / 0.34));
      const signalRef = ref('sig');
      await ctx.conn.reducers.insertSignal({
        signal: {
          ref: signalRef,
          newsId: news.id,
          conditionId: m.conditionId,
          layer: 'reflex',
          expectedDelta: deltaFromShift(price.mid, shift),
          deltaQ10: deltaFromShift(price.mid, shift * 0.3),
          deltaQ90: deltaFromShift(price.mid, shift * 1.6),
          halfLifeMin: 5,
          probYes: price.mid,
          probMarket: price.mid,
          confidence: Math.max(upP, downP),
          disagreement: 0,
          nAgents: 0,
          rationale: `System-1 reflex: ${reflexDir > 0 ? 'up' : 'down'} p=${Math.max(upP, downP).toFixed(2)}, urgency ${(urg?.prob ?? 0).toFixed(2)}`,
          analogCount: 0,
          analogMeanDelta: 0,
        },
        forecasts: [],
      });
      for (const s of sessionsForMarket(ctx, m.conditionId)) {
        if (s.risk.strategy === 'value') continue;
        followups.push(task('decide', `decide:${signalRef}:${s.id}`, { signalRef, sessionId: s.id.toString(), mode: 'reflex' }, { sessionId: s.id, priority: 100 }));
      }
    }
  }
  log.info('triaged', { news: news.id, relevant: relevant.length, urgency: urgency.toFixed(2), title: news.title.slice(0, 80) });
  return { result: { relevant: relevant.map(x => x.m.conditionId), entities: entities.length }, followups, usage: usage.get() };
};

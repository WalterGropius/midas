// MIDAS engine — boot sequence.
//
// Stateless by design: all state is in SpacetimeDB, so any process can die
// and another resumes. Roles:
//   leader  — markets, ingest, portfolio, scoring, scheduling, connectors
//   worker  — executes ledger tasks (scale horizontally)
//   all     — both (default; one container on Modal is enough to start)
import { config } from './config';
import { ActivityBuffer, type EngineCtx } from './ctx';
import { ensurePopulation } from './agents/population';
import { Alerts } from './connectors/alerts';
import { startHttp } from './connectors/http';
import { startTelegram } from './connectors/telegram';
import { scanArb } from './intel/arb';
import { deliberate } from './intel/deliberate';
import { forecastPaths } from './intel/forecast';
import { Ingest } from './intel/ingest';
import { swarm } from './intel/swarm';
import { triage } from './intel/triage';
import { calibrateAll } from './learn/calibrate';
import { coachReflexes, evolveAgents } from './learn/evolve';
import { reflect } from './learn/reflect';
import { scoreReactions, scoreResolutions } from './learn/score';
import { schedule } from './ledger/scheduler';
import type { Handler } from './ledger/types';
import { LedgerWorker } from './ledger/worker';
import { usage } from './llm/usage';
import { logger } from './log';
import { MarketHub } from './market/hub';
import { dream } from './memory/dream';
import { GraphMemory } from './memory/graph';
import { compileWiki } from './memory/wiki';
import { ReflexEngine } from './s1/reflexes';
import { activeProviderName } from './s1/systemone';
import { connectStdb, ensureEngineRole } from './stdb';
import { decide } from './trade/decide';
import { markAll } from './trade/portfolio';
import { every } from './util/async';
import { geminiAvailable } from './llm/gemini';

const log = logger('engine');

const HANDLERS: Record<string, Handler> = {
  triage,
  swarm,
  deliberate,
  decide,
  reflect,
  calibrate: calibrateAll,
  forecast: forecastPaths,
  wiki: compileWiki,
  dream,
  evolve: evolveAgents,
  coach: coachReflexes,
  arb: scanArb,
};

async function main() {
  log.info('starting', { version: config.version, role: config.role, worker: config.workerId, stdb: `${config.stdb.uri}/${config.stdb.database}` });
  // The control API comes up first so Modal's web_server health check passes
  // while we connect; it answers 503 on /api until the context is ready.
  let ctxRef: EngineCtx | undefined;
  let ingestRef: Ingest | undefined;
  startHttp(() => ctxRef, () => ingestRef);

  const stdb = await connectStdb();
  await ensureEngineRole(stdb);
  const activity = new ActivityBuffer();
  const ctx: EngineCtx = {
    conn: stdb.conn,
    identity: stdb.identity,
    reflexes: new ReflexEngine(stdb.conn),
    hub: new MarketHub(stdb.conn),
    graph: new GraphMemory(stdb.conn),
    alerts: new Alerts(),
    activity: item => activity.push(item),
  };
  ctxRef = ctx;
  await ctx.reflexes.ensureDefaults();
  await ensurePopulation(ctx.conn);
  if (!geminiAvailable()) log.warn('GEMINI_API_KEY missing: swarm/Pro/wiki/evolution are idle; System-1 falls back to heuristics');
  log.info('System-1 provider', { provider: activeProviderName() });

  const stops: (() => void)[] = [];
  const L = config.loops;

  if (config.role !== 'worker') {
    const ingest = new Ingest(ctx);
    ingestRef = ingest;
    stops.push(
      every('markets', L.marketRefreshSec * 1000, () => ctx.hub.refresh()),
      every('bars', 60_000, () => ctx.hub.flushBars(), { immediate: false }),
      every('poll-books', 30_000, () => ctx.hub.pollNonStreamed(), { immediate: false }),
      every('ingest', config.feeds.pollSec * 1000, async () => {
        await ingest.pollOnce();
      }),
      every('portfolio', L.markSec * 1000, () => markAll(ctx), { immediate: false }),
      every('score', L.scoreEverySec * 1000, async () => {
        await scoreReactions(ctx);
        await scoreResolutions(ctx);
      }, { immediate: false }),
      every('schedule', 60_000, () => schedule(ctx), { immediate: false }),
      startTelegram(ctx, ingest)
    );
  }

  let worker: LedgerWorker | undefined;
  if (config.role !== 'leader') {
    worker = new LedgerWorker(ctx, HANDLERS);
    worker.start();
    stops.push(() => worker!.stop());
  }

  // flush buffers + heartbeat
  stops.push(
    every('flush', 15_000, async () => {
      await activity.flush(ctx.conn);
      await ctx.reflexes.flush();
      await usage.flush(ctx.conn);
    }, { immediate: false }),
    every('heartbeat', L.heartbeatSec * 1000, async () => {
      await ctx.conn.reducers.heartbeat({
        workerId: config.workerId,
        version: config.version,
        status: 'ok',
        inflight: worker?.inflightCount() ?? 0,
        info: JSON.stringify({
          role: config.role,
          s1: activeProviderName(),
          gemini: geminiAvailable(),
          timesfm: Boolean(config.modal.url),
          live: config.live.enabled,
          done: worker?.completed ?? 0,
          failed: worker?.failed ?? 0,
          spentToday: Number(usage.spent().toFixed(4)),
        }),
      });
    })
  );

  const shutdown = async (sig: string) => {
    log.info('shutting down', { sig });
    for (const s of stops) s();
    try {
      await activity.flush(ctx.conn);
      await ctx.reflexes.flush();
      await usage.flush(ctx.conn);
    } catch {
      /* best effort */
    }
    ctx.hub.stream.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  log.info('engine up', { watched: ctx.hub.watched().size, sessions: Number(ctx.conn.db.session.count()) });
}

main().catch(err => {
  log.error('fatal', { err: String((err as Error)?.stack ?? err) });
  process.exit(1);
});

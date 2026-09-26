// MIDAS — SpacetimeDB reducers.
//
// Reducers are transactional and deterministic: no network, no clocks, no
// Math.random. Time comes from ctx.timestamp, identity from ctx.sender.
// Clients (the Next.js UI, engine workers) read everything via subscriptions.
import spacetimedb, {
  ActivityInput,
  AgentForecastInput,
  AgentForecastScoreInput,
  AgentInput,
  CalibrationOutcomeInput,
  CalibrationSampleInput,
  CalibratorInput,
  DecisionInput,
  EquityPointInput,
  IntelConfig,
  LlmUsageInput,
  MarketInput,
  MemEdgeInput,
  MemNodeInput,
  NewsInput,
  NewsTriageInput,
  OrderInput,
  PathForecastInput,
  PositionInput,
  PriceBarInput,
  ReflexInput,
  ReflexStatsInput,
  RiskConfig,
  SeedFileInput,
  SessionAccountingInput,
  SessionMarketInput,
  SignalInput,
  SignalScoreInput,
  TaskInput,
  TaskUsageInput,
  TrialInput,
  housekeepingTimer,
} from './schema';
import { t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { ScheduleAt, Timestamp, type Infer } from 'spacetimedb';

export { default } from './schema';

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const MICROS_PER_SEC = 1_000_000n;
const SESSION_STATUSES = ['running', 'paused', 'stopped', 'killed', 'pending_approval', 'archived'];
const TASK_TERMINAL = ['done', 'failed', 'cancelled'];

// ───────────────────────────── helpers (not exported) ─────────────────────────────

function now(ctx: Ctx): bigint {
  return ctx.timestamp.microsSinceUnixEpoch;
}

function ts(micros: bigint): Timestamp {
  return new Timestamp(micros);
}

function operatorRole(ctx: Ctx): string | undefined {
  return ctx.db.operator.identity.find(ctx.sender)?.role;
}

function requireAdmin(ctx: Ctx) {
  if (operatorRole(ctx) !== 'admin') throw new SenderError('admin only');
}

// Engine reducers write intelligence, orders and accounting. Admins may also
// call them (manual repair from the CLI).
function requireEngine(ctx: Ctx) {
  const role = operatorRole(ctx);
  if (role !== 'engine' && role !== 'admin') throw new SenderError('engine only');
}

function isEngine(ctx: Ctx): boolean {
  const role = operatorRole(ctx);
  return role === 'engine' || role === 'admin';
}

function requireSession(ctx: Ctx, sessionId: bigint) {
  const s = ctx.db.session.id.find(sessionId);
  if (!s) throw new SenderError(`session ${sessionId} not found`);
  return s;
}

function requireOwnerOrEngine(ctx: Ctx, sessionId: bigint) {
  const s = requireSession(ctx, sessionId);
  if (!s.owner.equals(ctx.sender) && !isEngine(ctx)) throw new SenderError('not your session');
  return s;
}

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'session'
  );
}

function sanitizeRisk(r: Infer<typeof RiskConfig>): Infer<typeof RiskConfig> {
  const strategy = ['reaction', 'value', 'both'].includes(r.strategy) ? r.strategy : 'both';
  return {
    kellyFraction: clamp(r.kellyFraction, 0, 1),
    maxPositionPct: clamp(r.maxPositionPct, 0, 1),
    maxGrossExposurePct: clamp(r.maxGrossExposurePct, 0, 1),
    maxDailyLossPct: clamp(r.maxDailyLossPct, 0, 1),
    maxDrawdownPct: clamp(r.maxDrawdownPct, 0, 1),
    minEdge: clamp(r.minEdge, 0, 0.5),
    maxSpread: clamp(r.maxSpread, 0, 1),
    modelTrust: clamp(r.modelTrust, 0, 1),
    maxOpenPositions: Math.max(0, Math.min(200, r.maxOpenPositions)),
    strategy,
  };
}

function sanitizeIntel(i: Infer<typeof IntelConfig>): Infer<typeof IntelConfig> {
  return {
    swarmSize: Math.max(1, Math.min(32, i.swarmSize)),
    proCallsPerHour: Math.max(0, Math.min(600, i.proCallsPerHour)),
    escalateEdge: clamp(i.escalateEdge, 0, 1),
    escalateDisagreement: clamp(i.escalateDisagreement, 0, 10),
    dailyLlmBudgetUsd: clamp(i.dailyLlmBudgetUsd, 0, 100_000),
  };
}

function logActivity(
  ctx: Ctx,
  sessionId: bigint,
  level: string,
  kind: string,
  message: string,
  refId = ''
) {
  ctx.db.activity.insert({
    id: 0n,
    sessionId,
    ts: ctx.timestamp,
    level,
    kind,
    message: message.slice(0, 2000),
    refId,
  });
}

function upsertSeedFileRow(
  ctx: Ctx,
  sessionId: bigint,
  path: string,
  kind: string,
  content: string,
  updatedBy: string
) {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!clean || clean.includes('..')) throw new SenderError(`bad path: ${path}`);
  if (content.length > 200_000) throw new SenderError(`${clean}: file too large`);
  for (const f of ctx.db.seedFile.sessionId.filter(sessionId)) {
    if (f.path === clean) {
      ctx.db.seedFile.id.update({
        ...f,
        kind,
        content,
        version: f.version + 1,
        updatedBy,
        updatedAt: ctx.timestamp,
      });
      return;
    }
  }
  ctx.db.seedFile.insert({
    id: 0n,
    sessionId,
    path: clean,
    kind,
    content,
    version: 1,
    updatedBy,
    updatedAt: ctx.timestamp,
  });
}

function addSessionMarketRow(ctx: Ctx, sessionId: bigint, m: Infer<typeof SessionMarketInput>) {
  const conditionId = m.conditionId.trim();
  if (!conditionId) return;
  for (const existing of ctx.db.sessionMarket.sessionId.filter(sessionId)) {
    if (existing.conditionId === conditionId) return;
  }
  ctx.db.sessionMarket.insert({
    id: 0n,
    sessionId,
    conditionId,
    note: m.note.slice(0, 4000),
    prior: m.prior === undefined ? undefined : clamp(m.prior, 0.001, 0.999),
    addedAt: ctx.timestamp,
  });
}

function enqueueTask(ctx: Ctx, task: Infer<typeof TaskInput>) {
  if (!task.dedupeKey) throw new SenderError('task.dedupeKey required');
  if (ctx.db.agentTask.dedupeKey.find(task.dedupeKey)) return; // idempotent
  const deps: bigint[] = [];
  let cancelled = false;
  for (const key of task.dependsOn) {
    const dep = ctx.db.agentTask.dedupeKey.find(key);
    if (!dep) continue; // unknown dependency: treat as satisfied
    if (dep.status === 'done') continue;
    if (dep.status === 'failed' || dep.status === 'cancelled') cancelled = true;
    else deps.push(dep.id);
  }
  const t0 = now(ctx);
  const notBefore = task.notBeforeMicros > t0 ? task.notBeforeMicros : t0;
  ctx.db.agentTask.insert({
    id: 0n,
    dedupeKey: task.dedupeKey,
    kind: task.kind,
    sessionId: task.sessionId,
    status: cancelled ? 'cancelled' : deps.length > 0 ? 'blocked' : 'pending',
    priority: task.priority,
    deps,
    payload: task.payload,
    result: '',
    error: cancelled ? 'dependency failed' : '',
    attempts: 0,
    maxAttempts: Math.max(1, task.maxAttempts),
    leaseOwner: '',
    leaseUntil: ctx.timestamp,
    notBefore: ts(notBefore),
    model: '',
    tokensIn: 0,
    tokensOut: 0,
    cachedTokens: 0,
    costUsd: 0,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
}

// Falling dominoes: unblock tasks whose last dependency just finished.
function releaseDependents(ctx: Ctx, doneId: bigint) {
  for (const blocked of [...ctx.db.agentTask.status.filter('blocked')]) {
    if (!blocked.deps.includes(doneId)) continue;
    const deps = blocked.deps.filter((d: bigint) => d !== doneId);
    ctx.db.agentTask.id.update({
      ...blocked,
      deps,
      status: deps.length === 0 ? 'pending' : 'blocked',
      updatedAt: ctx.timestamp,
    });
  }
}

function cancelDependents(ctx: Ctx, failedId: bigint) {
  const queue: bigint[] = [failedId];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const blocked of [...ctx.db.agentTask.status.filter('blocked')]) {
      if (!blocked.deps.includes(id)) continue;
      ctx.db.agentTask.id.update({
        ...blocked,
        status: 'cancelled',
        error: `dependency ${id} failed`,
        updatedAt: ctx.timestamp,
      });
      queue.push(blocked.id);
    }
  }
}

function hourBucket(micros: bigint): bigint {
  const hour = 3600n * MICROS_PER_SEC;
  return (micros / hour) * hour;
}

// ─────────────────────────────── lifecycle ───────────────────────────────

export const init = spacetimedb.init(ctx => {
  ctx.db.housekeepingTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(30n * MICROS_PER_SEC),
    job: 'reap',
  });
  ctx.db.housekeepingTimer.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(3600n * MICROS_PER_SEC),
    job: 'prune',
  });
  ctx.db.globalFlag.insert({ key: 'halt_all', value: 'false', updatedAt: ctx.timestamp });
});

export const onConnect = spacetimedb.clientConnected(_ctx => {});

export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {});

export const housekeeping = spacetimedb.reducer(
  { onSchedule: housekeepingTimer },
  { timer: housekeepingTimer.rowType },
  (ctx, { timer }) => {
    const t0 = now(ctx);
    if (timer.job === 'reap') {
      // Leases that expired belong to dead or stuck workers: requeue.
      for (const task of [...ctx.db.agentTask.status.filter('running')]) {
        if (task.leaseUntil.microsSinceUnixEpoch >= t0) continue;
        const exhausted = task.attempts >= task.maxAttempts;
        ctx.db.agentTask.id.update({
          ...task,
          status: exhausted ? 'failed' : 'pending',
          error: `lease expired (worker ${task.leaseOwner})`,
          leaseOwner: '',
          updatedAt: ctx.timestamp,
        });
        if (exhausted) cancelDependents(ctx, task.id);
      }
      return;
    }
    if (timer.job === 'prune') {
      const day = 86_400n * MICROS_PER_SEC;
      for (const status of TASK_TERMINAL) {
        for (const task of [...ctx.db.agentTask.status.filter(status)]) {
          if (t0 - task.updatedAt.microsSinceUnixEpoch > 7n * day) ctx.db.agentTask.id.delete(task.id);
        }
      }
      for (const a of [...ctx.db.activity.iter()]) {
        if (t0 - a.ts.microsSinceUnixEpoch > 3n * day) ctx.db.activity.id.delete(a.id);
      }
      for (const b of [...ctx.db.priceBar.iter()]) {
        if (t0 - b.ts.microsSinceUnixEpoch > 14n * day) ctx.db.priceBar.id.delete(b.id);
      }
      for (const p of [...ctx.db.pathForecast.iter()]) {
        if (t0 - p.createdAt.microsSinceUnixEpoch > 2n * day) ctx.db.pathForecast.id.delete(p.id);
      }
      for (const h of [...ctx.db.engineHeartbeat.iter()]) {
        if (t0 - h.lastSeen.microsSinceUnixEpoch > day) ctx.db.engineHeartbeat.workerId.delete(h.workerId);
      }
      for (const c of [...ctx.db.calibrationSample.iter()]) {
        if (t0 - c.createdAt.microsSinceUnixEpoch > 60n * day) ctx.db.calibrationSample.id.delete(c.id);
      }
      for (const u of [...ctx.db.llmUsage.iter()]) {
        if (t0 - u.hour.microsSinceUnixEpoch > 30n * day) ctx.db.llmUsage.key.delete(u.key);
      }
    }
  }
);

// ─────────────────────────────── operators ───────────────────────────────

// First caller per role wins (trust-on-first-use). Claim 'admin' from the UI
// right after publishing; the engine claims 'engine' on first boot. Later
// claims become requests an admin must approve.
export const claimOperator = spacetimedb.reducer({ role: t.string() }, (ctx, { role }) => {
  if (role !== 'admin' && role !== 'engine') throw new SenderError('role must be admin|engine');
  const existing = ctx.db.operator.identity.find(ctx.sender);
  if (existing) {
    if (existing.role === role || existing.role === 'admin') return;
  }
  const roleTaken = [...ctx.db.operator.iter()].some(o => o.role === role);
  if (!roleTaken && !existing) {
    ctx.db.operator.insert({ identity: ctx.sender, role, createdAt: ctx.timestamp });
    logActivity(ctx, 0n, 'info', 'operator', `${role} claimed by ${ctx.sender.toHexString().slice(0, 12)}…`);
    return;
  }
  for (const r of ctx.db.operatorRequest.iter()) {
    if (r.identity.equals(ctx.sender) && r.role === role && r.status === 'pending') return;
  }
  ctx.db.operatorRequest.insert({
    id: 0n,
    identity: ctx.sender,
    role,
    status: 'pending',
    createdAt: ctx.timestamp,
  });
});

export const resolveOperatorRequest = spacetimedb.reducer(
  { requestId: t.u64(), approve: t.bool() },
  (ctx, { requestId, approve }) => {
    requireAdmin(ctx);
    const req = ctx.db.operatorRequest.id.find(requestId);
    if (!req || req.status !== 'pending') throw new SenderError('no such pending request');
    ctx.db.operatorRequest.id.update({ ...req, status: approve ? 'approved' : 'rejected' });
    if (!approve) return;
    const existing = ctx.db.operator.identity.find(req.identity);
    if (existing) ctx.db.operator.identity.update({ ...existing, role: req.role });
    else ctx.db.operator.insert({ identity: req.identity, role: req.role, createdAt: ctx.timestamp });
  }
);

// 'halt_all' = 'true' stops every order everywhere (engine and UI kill switch).
export const setFlag = spacetimedb.reducer({ key: t.string(), value: t.string() }, (ctx, { key, value }) => {
  requireEngine(ctx);
  const row = ctx.db.globalFlag.key.find(key);
  if (row) ctx.db.globalFlag.key.update({ ...row, value, updatedAt: ctx.timestamp });
  else ctx.db.globalFlag.insert({ key, value, updatedAt: ctx.timestamp });
  logActivity(ctx, 0n, 'warn', 'flag', `${key} = ${value}`);
});

// ──────────────────────────────── sessions ────────────────────────────────

export const createSession = spacetimedb.reducer(
  {
    name: t.string(),
    mode: t.string(),
    bankrollUsd: t.f64(),
    risk: RiskConfig,
    intel: IntelConfig,
    thesis: t.string(),
    markets: t.array(SessionMarketInput),
    files: t.array(SeedFileInput),
  },
  (ctx, args) => {
    const name = args.name.trim().slice(0, 120);
    if (!name) throw new SenderError('name required');
    if (!(args.bankrollUsd > 0) || args.bankrollUsd > 10_000_000) throw new SenderError('bankroll out of range');
    const mode = args.mode === 'live' ? 'live' : 'paper';
    const row = ctx.db.session.insert({
      id: 0n,
      owner: ctx.sender,
      name,
      slug: slugify(name),
      status: mode === 'live' ? 'pending_approval' : 'running',
      statusReason: mode === 'live' ? 'live trading requires admin approval' : '',
      mode,
      liveApproved: false,
      bankrollUsd: args.bankrollUsd,
      cashUsd: args.bankrollUsd,
      equityUsd: args.bankrollUsd,
      peakEquityUsd: args.bankrollUsd,
      dayStartEquityUsd: args.bankrollUsd,
      realizedPnlUsd: 0,
      feesPaidUsd: 0,
      exposureUsd: 0,
      risk: sanitizeRisk(args.risk),
      intel: sanitizeIntel(args.intel),
      thesis: args.thesis.slice(0, 20_000),
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });
    for (const m of args.markets) addSessionMarketRow(ctx, row.id, m);
    for (const f of args.files) upsertSeedFileRow(ctx, row.id, f.path, f.kind, f.content, 'user');
    logActivity(ctx, row.id, 'info', 'session', `session "${name}" created (${mode}, $${args.bankrollUsd})`);
  }
);

export const updateSessionConfig = spacetimedb.reducer(
  {
    sessionId: t.u64(),
    name: t.string(),
    bankrollUsd: t.f64(),
    risk: RiskConfig,
    intel: IntelConfig,
    thesis: t.string(),
  },
  (ctx, args) => {
    const s = requireSession(ctx, args.sessionId);
    if (!s.owner.equals(ctx.sender)) throw new SenderError('not your session');
    if (!(args.bankrollUsd > 0)) throw new SenderError('bankroll must be positive');
    // Changing the bankroll is a deposit/withdrawal against cash.
    const delta = args.bankrollUsd - s.bankrollUsd;
    ctx.db.session.id.update({
      ...s,
      name: args.name.trim().slice(0, 120) || s.name,
      bankrollUsd: args.bankrollUsd,
      cashUsd: s.cashUsd + delta,
      equityUsd: s.equityUsd + delta,
      peakEquityUsd: s.peakEquityUsd + delta,
      dayStartEquityUsd: s.dayStartEquityUsd + delta,
      risk: sanitizeRisk(args.risk),
      intel: sanitizeIntel(args.intel),
      thesis: args.thesis.slice(0, 20_000),
      updatedAt: ctx.timestamp,
    });
  }
);

export const setSessionStatus = spacetimedb.reducer(
  { sessionId: t.u64(), status: t.string(), reason: t.string() },
  (ctx, { sessionId, status, reason }) => {
    const s = requireOwnerOrEngine(ctx, sessionId);
    if (!SESSION_STATUSES.includes(status)) throw new SenderError(`bad status ${status}`);
    if (status === 'running' && s.mode === 'live' && !s.liveApproved) {
      throw new SenderError('live session not approved by an admin');
    }
    if (status === 'archived') {
      const open = [...ctx.db.position.sessionId.filter(sessionId)].some(p => !p.closed);
      if (open) throw new SenderError('close positions before archiving');
    }
    ctx.db.session.id.update({ ...s, status, statusReason: reason.slice(0, 500), updatedAt: ctx.timestamp });
    logActivity(ctx, sessionId, status === 'killed' ? 'error' : 'info', 'status', `${status}${reason ? `: ${reason}` : ''}`);
  }
);

export const setSessionMode = spacetimedb.reducer(
  { sessionId: t.u64(), mode: t.string() },
  (ctx, { sessionId, mode }) => {
    const s = requireSession(ctx, sessionId);
    if (!s.owner.equals(ctx.sender)) throw new SenderError('not your session');
    if (mode !== 'paper' && mode !== 'live') throw new SenderError('mode must be paper|live');
    const open = [...ctx.db.position.sessionId.filter(sessionId)].some(p => !p.closed);
    if (open) throw new SenderError('close positions before switching mode');
    ctx.db.session.id.update({
      ...s,
      mode,
      liveApproved: false,
      status: mode === 'live' ? 'pending_approval' : s.status === 'pending_approval' ? 'running' : s.status,
      statusReason: mode === 'live' ? 'live trading requires admin approval' : '',
      updatedAt: ctx.timestamp,
    });
  }
);

export const approveLive = spacetimedb.reducer(
  { sessionId: t.u64(), approve: t.bool() },
  (ctx, { sessionId, approve }) => {
    requireAdmin(ctx);
    const s = requireSession(ctx, sessionId);
    if (s.mode !== 'live') throw new SenderError('session is not in live mode');
    ctx.db.session.id.update({
      ...s,
      liveApproved: approve,
      status: approve ? 'running' : 'paused',
      statusReason: approve ? '' : 'live trading rejected by admin',
      updatedAt: ctx.timestamp,
    });
    logActivity(ctx, sessionId, 'warn', 'live', approve ? 'LIVE trading approved' : 'live trading rejected');
  }
);

export const addSessionMarket = spacetimedb.reducer(
  { sessionId: t.u64(), market: SessionMarketInput },
  (ctx, { sessionId, market }) => {
    requireOwnerOrEngine(ctx, sessionId);
    addSessionMarketRow(ctx, sessionId, market);
  }
);

export const removeSessionMarket = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) => {
  const row = ctx.db.sessionMarket.id.find(id);
  if (!row) return;
  requireOwnerOrEngine(ctx, row.sessionId);
  ctx.db.sessionMarket.id.delete(id);
});

export const upsertSeedFile = spacetimedb.reducer(
  { sessionId: t.u64(), file: SeedFileInput },
  (ctx, { sessionId, file }) => {
    const s = requireOwnerOrEngine(ctx, sessionId);
    const by = s.owner.equals(ctx.sender) ? 'user' : 'engine';
    // raw/ is the immutable evidence layer: the engine never rewrites it.
    if (by === 'engine' && file.kind === 'raw') throw new SenderError('engine may not modify raw/ sources');
    upsertSeedFileRow(ctx, sessionId, file.path, file.kind, file.content, by);
  }
);

export const deleteSeedFile = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) => {
  const f = ctx.db.seedFile.id.find(id);
  if (!f) return;
  const s = requireSession(ctx, f.sessionId);
  if (!s.owner.equals(ctx.sender)) throw new SenderError('not your session');
  ctx.db.seedFile.id.delete(id);
});

export const updateSessionAccounting = spacetimedb.reducer(
  { items: t.array(SessionAccountingInput) },
  (ctx, { items }) => {
    requireEngine(ctx);
    for (const a of items) {
      const s = ctx.db.session.id.find(a.sessionId);
      if (!s) continue;
      ctx.db.session.id.update({
        ...s,
        cashUsd: a.cashUsd,
        equityUsd: a.equityUsd,
        peakEquityUsd: a.peakEquityUsd,
        dayStartEquityUsd: a.dayStartEquityUsd,
        realizedPnlUsd: a.realizedPnlUsd,
        feesPaidUsd: a.feesPaidUsd,
        exposureUsd: a.exposureUsd,
        updatedAt: ctx.timestamp,
      });
    }
  }
);

export const recordEquity = spacetimedb.reducer({ points: t.array(EquityPointInput) }, (ctx, { points }) => {
  requireEngine(ctx);
  for (const p of points) {
    ctx.db.equityPoint.insert({ id: 0n, ts: ctx.timestamp, ...p });
  }
});

// ───────────────────────────── markets & news ─────────────────────────────

export const upsertMarkets = spacetimedb.reducer({ markets: t.array(MarketInput) }, (ctx, { markets }) => {
  requireEngine(ctx);
  for (const m of markets) {
    const existing = ctx.db.market.conditionId.find(m.conditionId);
    if (existing) {
      ctx.db.market.conditionId.update({ ...existing, ...m, updatedAt: ctx.timestamp });
    } else {
      ctx.db.market.insert({ ...m, resolved: false, outcomeYes: undefined, updatedAt: ctx.timestamp });
    }
  }
});

export const setMarketResolution = spacetimedb.reducer(
  { conditionId: t.string(), outcomeYes: t.f64() },
  (ctx, { conditionId, outcomeYes }) => {
    requireEngine(ctx);
    const m = ctx.db.market.conditionId.find(conditionId);
    if (!m || m.resolved) return;
    ctx.db.market.conditionId.update({
      ...m,
      resolved: true,
      closed: true,
      active: false,
      outcomeYes: clamp(outcomeYes, 0, 1),
      updatedAt: ctx.timestamp,
    });
    logActivity(ctx, 0n, 'info', 'resolution', `${m.question} → ${outcomeYes >= 0.5 ? 'YES' : 'NO'}`, conditionId);
  }
);

export const insertPriceBars = spacetimedb.reducer({ bars: t.array(PriceBarInput) }, (ctx, { bars }) => {
  requireEngine(ctx);
  for (const b of bars) ctx.db.priceBar.insert({ id: 0n, ...b });
});

export const insertNews = spacetimedb.reducer({ items: t.array(NewsInput) }, (ctx, { items }) => {
  requireEngine(ctx);
  for (const n of items) {
    if (ctx.db.newsItem.hash.find(n.hash)) continue;
    ctx.db.newsItem.insert({
      id: 0n,
      ...n,
      title: n.title.slice(0, 500),
      summary: n.summary.slice(0, 4000),
      ingestedAt: ctx.timestamp,
      status: 'new',
      sentiment: 0,
      novelty: 0,
      eventType: '',
      entities: [],
      marketIds: [],
      triageNote: '',
    });
  }
});

export const updateNewsTriage = spacetimedb.reducer({ updates: t.array(NewsTriageInput) }, (ctx, { updates }) => {
  requireEngine(ctx);
  for (const u of updates) {
    const n = ctx.db.newsItem.id.find(u.newsId);
    if (!n) continue;
    ctx.db.newsItem.id.update({
      ...n,
      status: u.status,
      urgency: u.urgency,
      sentiment: u.sentiment,
      novelty: u.novelty,
      eventType: u.eventType,
      entities: u.entities.slice(0, 32),
      marketIds: u.marketIds.slice(0, 32),
      triageNote: u.triageNote.slice(0, 1000),
    });
  }
});

// ───────────────────────────── intelligence artifacts ─────────────────────────────

export const insertSignal = spacetimedb.reducer(
  { signal: SignalInput, forecasts: t.array(AgentForecastInput) },
  (ctx, { signal, forecasts }) => {
    requireEngine(ctx);
    if (ctx.db.signal.ref.find(signal.ref)) return;
    const row = ctx.db.signal.insert({
      id: 0n,
      ...signal,
      rationale: signal.rationale.slice(0, 4000),
      createdAt: ctx.timestamp,
      realizedShort: undefined,
      realizedMid: undefined,
      realizedLong: undefined,
      absError: undefined,
      status: 'open',
    });
    for (const f of forecasts) {
      ctx.db.agentForecast.insert({
        id: 0n,
        signalId: row.id,
        conditionId: signal.conditionId,
        createdAt: ctx.timestamp,
        ...f,
        rationale: f.rationale.slice(0, 1500),
        brier: undefined,
        reactionErr: undefined,
      });
    }
  }
);

export const scoreSignals = spacetimedb.reducer({ scores: t.array(SignalScoreInput) }, (ctx, { scores }) => {
  requireEngine(ctx);
  for (const s of scores) {
    const row = ctx.db.signal.id.find(s.signalId);
    if (!row) continue;
    ctx.db.signal.id.update({
      ...row,
      realizedShort: s.realizedShort ?? row.realizedShort,
      realizedMid: s.realizedMid ?? row.realizedMid,
      realizedLong: s.realizedLong ?? row.realizedLong,
      absError: s.absError ?? row.absError,
      status: s.final ? 'scored' : row.status,
    });
  }
});

export const scoreAgentForecasts = spacetimedb.reducer(
  { scores: t.array(AgentForecastScoreInput) },
  (ctx, { scores }) => {
    requireEngine(ctx);
    for (const s of scores) {
      const row = ctx.db.agentForecast.id.find(s.forecastId);
      if (!row) continue;
      ctx.db.agentForecast.id.update({
        ...row,
        brier: s.brier ?? row.brier,
        reactionErr: s.reactionErr ?? row.reactionErr,
      });
    }
  }
);

export const insertPathForecast = spacetimedb.reducer({ forecast: PathForecastInput }, (ctx, { forecast }) => {
  requireEngine(ctx);
  ctx.db.pathForecast.insert({ id: 0n, ...forecast, createdAt: ctx.timestamp });
  // keep the 12 most recent per market
  const rows = [...ctx.db.pathForecast.conditionId.filter(forecast.conditionId)].sort((a, b) =>
    a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch ? 1 : -1
  );
  for (const old of rows.slice(12)) ctx.db.pathForecast.id.delete(old.id);
});

// ───────────────────────────── trading records ─────────────────────────────

export const recordDecision = spacetimedb.reducer({ decision: DecisionInput }, (ctx, { decision }) => {
  requireEngine(ctx);
  if (ctx.db.decision.ref.find(decision.ref)) return;
  ctx.db.decision.insert({
    id: 0n,
    ...decision,
    reasons: decision.reasons.slice(0, 24).map(r => r.slice(0, 300)),
    createdAt: ctx.timestamp,
  });
});

export const upsertOrders = spacetimedb.reducer({ orders: t.array(OrderInput) }, (ctx, { orders }) => {
  requireEngine(ctx);
  for (const o of orders) {
    const existing = ctx.db.tradeOrder.ref.find(o.ref);
    if (existing) {
      ctx.db.tradeOrder.id.update({ ...existing, ...o, id: existing.id, createdAt: existing.createdAt, updatedAt: ctx.timestamp });
    } else {
      ctx.db.tradeOrder.insert({ id: 0n, ...o, createdAt: ctx.timestamp, updatedAt: ctx.timestamp });
    }
  }
});

export const upsertPositions = spacetimedb.reducer({ positions: t.array(PositionInput) }, (ctx, { positions }) => {
  requireEngine(ctx);
  for (const p of positions) {
    let open: (typeof ctx.db.position extends { iter(): Iterable<infer R> } ? R : never) | undefined;
    for (const row of ctx.db.position.sessionId.filter(p.sessionId)) {
      if (!row.closed && row.conditionId === p.conditionId && row.outcome === p.outcome) {
        open = row;
        break;
      }
    }
    if (open) {
      ctx.db.position.id.update({ ...open, ...p, id: open.id, openedAt: open.openedAt, updatedAt: ctx.timestamp });
    } else if (!p.closed) {
      ctx.db.position.insert({ id: 0n, ...p, openedAt: ctx.timestamp, updatedAt: ctx.timestamp });
    }
  }
});

// ───────────────────────────── agents & evolution ─────────────────────────────

export const upsertAgents = spacetimedb.reducer({ agents: t.array(AgentInput) }, (ctx, { agents }) => {
  requireEngine(ctx);
  for (const a of agents) {
    const fields = {
      ...a,
      instructions: a.instructions.slice(0, 12_000),
      persona: a.persona.slice(0, 2000),
      lineageNote: a.lineageNote.slice(0, 2000),
      temperature: clamp(a.temperature, 0, 2),
      weight: Math.max(0, a.weight),
    };
    const existing = a.id === 0n ? undefined : ctx.db.agent.id.find(a.id);
    if (existing) {
      ctx.db.agent.id.update({ ...existing, ...fields, id: existing.id, createdAt: existing.createdAt, updatedAt: ctx.timestamp });
    } else {
      ctx.db.agent.insert({ ...fields, id: 0n, createdAt: ctx.timestamp, updatedAt: ctx.timestamp });
    }
  }
});

export const recordTrial = spacetimedb.reducer({ trial: TrialInput }, (ctx, { trial }) => {
  requireEngine(ctx);
  ctx.db.evolutionTrial.insert({ id: 0n, ...trial, mutation: trial.mutation.slice(0, 4000), createdAt: ctx.timestamp });
  logActivity(
    ctx,
    0n,
    trial.decision === 'kept' ? 'info' : 'debug',
    'evolution',
    `gen ${trial.generation}: ${trial.subject} ${trial.decision} (${trial.metric} ${trial.baselineScore.toFixed(4)} → ${trial.candidateScore.toFixed(4)})`
  );
});

// ─────────────────────────────── graph memory ───────────────────────────────

export const upsertMemNodes = spacetimedb.reducer({ nodes: t.array(MemNodeInput) }, (ctx, { nodes }) => {
  requireEngine(ctx);
  for (const n of nodes) {
    const existing = ctx.db.memNode.key.find(n.key);
    if (existing) {
      const aliases = [...new Set([...existing.aliases, ...n.aliases])].slice(0, 32);
      // Never silently downgrade canonical knowledge back to draft.
      const status =
        existing.status === 'canonical' && n.status === 'draft' ? 'canonical' : n.status || existing.status;
      ctx.db.memNode.id.update({
        ...existing,
        label: n.label || existing.label,
        aliases,
        summary: n.summary ? n.summary.slice(0, 4000) : existing.summary,
        status,
        salience: Math.max(0, existing.salience + n.salienceDelta),
        mentionCount: existing.mentionCount + 1,
        helpful: existing.helpful + n.helpfulDelta,
        harmful: existing.harmful + n.harmfulDelta,
        embedding: n.embedding.length > 0 ? n.embedding : existing.embedding,
        updatedAt: ctx.timestamp,
      });
    } else {
      ctx.db.memNode.insert({
        id: 0n,
        key: n.key,
        kind: n.kind,
        label: n.label,
        aliases: n.aliases.slice(0, 32),
        summary: n.summary.slice(0, 4000),
        sessionId: n.sessionId,
        status: n.status || 'draft',
        salience: Math.max(0, n.salienceDelta),
        mentionCount: 1,
        helpful: n.helpfulDelta,
        harmful: n.harmfulDelta,
        embedding: n.embedding,
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
      });
    }
  }
});

export const upsertMemEdges = spacetimedb.reducer({ edges: t.array(MemEdgeInput) }, (ctx, { edges }) => {
  requireEngine(ctx);
  for (const e of edges) {
    const src = ctx.db.memNode.key.find(e.srcKey);
    const dst = ctx.db.memNode.key.find(e.dstKey);
    if (!src || !dst) continue; // provenance rule: no edge without both endpoints
    const existing = ctx.db.memEdge.key.find(e.key);
    if (existing) {
      ctx.db.memEdge.id.update({
        ...existing,
        weight: e.weight,
        value: e.value,
        lagMin: e.lagMin,
        evidence: e.evidence ? e.evidence.slice(0, 1000) : existing.evidence,
        status: existing.status === 'canonical' && e.status === 'draft' ? 'canonical' : e.status || existing.status,
      });
    } else {
      ctx.db.memEdge.insert({
        id: 0n,
        key: e.key,
        src: src.id,
        dst: dst.id,
        rel: e.rel,
        weight: e.weight,
        value: e.value,
        lagMin: e.lagMin,
        evidence: e.evidence.slice(0, 1000),
        sessionId: e.sessionId,
        status: e.status || 'draft',
        createdAt: ctx.timestamp,
        validFrom: ctx.timestamp,
        invalidatedAt: undefined,
      });
    }
  }
});

export const invalidateMemEdges = spacetimedb.reducer({ keys: t.array(t.string()) }, (ctx, { keys }) => {
  requireEngine(ctx);
  for (const key of keys) {
    const e = ctx.db.memEdge.key.find(key);
    if (e && !e.invalidatedAt) ctx.db.memEdge.id.update({ ...e, invalidatedAt: ctx.timestamp });
  }
});

// Entity resolution is reversible: the merged node stays, marked 'merged',
// linked to its canonical twin by a 'merged_into' edge. Unmerge restores it.
export const mergeMemNodes = spacetimedb.reducer(
  { fromKey: t.string(), intoKey: t.string(), evidence: t.string() },
  (ctx, { fromKey, intoKey, evidence }) => {
    requireEngine(ctx);
    const from = ctx.db.memNode.key.find(fromKey);
    const into = ctx.db.memNode.key.find(intoKey);
    if (!from || !into || from.id === into.id) return;
    ctx.db.memNode.id.update({ ...from, status: 'merged', updatedAt: ctx.timestamp });
    ctx.db.memNode.id.update({
      ...into,
      aliases: [...new Set([...into.aliases, from.label, ...from.aliases])].slice(0, 32),
      salience: into.salience + from.salience,
      updatedAt: ctx.timestamp,
    });
    const key = `${fromKey}|merged_into|${intoKey}`;
    const existing = ctx.db.memEdge.key.find(key);
    if (existing) ctx.db.memEdge.id.update({ ...existing, invalidatedAt: undefined, evidence });
    else
      ctx.db.memEdge.insert({
        id: 0n,
        key,
        src: from.id,
        dst: into.id,
        rel: 'merged_into',
        weight: 1,
        value: 0,
        lagMin: 0,
        evidence,
        sessionId: 0n,
        status: 'canonical',
        createdAt: ctx.timestamp,
        validFrom: ctx.timestamp,
        invalidatedAt: undefined,
      });
  }
);

export const unmergeMemNode = spacetimedb.reducer({ key: t.string() }, (ctx, { key }) => {
  requireEngine(ctx);
  const node = ctx.db.memNode.key.find(key);
  if (!node || node.status !== 'merged') return;
  ctx.db.memNode.id.update({ ...node, status: 'canonical', updatedAt: ctx.timestamp });
  for (const e of [...ctx.db.memEdge.src.filter(node.id)]) {
    if (e.rel === 'merged_into' && !e.invalidatedAt) ctx.db.memEdge.id.update({ ...e, invalidatedAt: ctx.timestamp });
  }
});

// ───────────────────────────── the synaptic ledger ─────────────────────────────

export const enqueueTasks = spacetimedb.reducer({ tasks: t.array(TaskInput) }, (ctx, { tasks }) => {
  requireEngine(ctx);
  for (const task of tasks) enqueueTask(ctx, task);
});

// Reducers return nothing: after this commits, the worker finds its claimed
// rows in the subscription cache (status 'running', leaseOwner = workerId).
export const claimTasks = spacetimedb.reducer(
  { workerId: t.string(), kinds: t.array(t.string()), max: t.u32(), leaseSec: t.u32() },
  (ctx, { workerId, kinds, max, leaseSec }) => {
    requireEngine(ctx);
    const t0 = now(ctx);
    const runnable = [...ctx.db.agentTask.status.filter('pending')]
      .filter(task => task.notBefore.microsSinceUnixEpoch <= t0)
      .filter(task => kinds.length === 0 || kinds.includes(task.kind))
      .sort((a, b) =>
        b.priority !== a.priority
          ? b.priority - a.priority
          : a.createdAt.microsSinceUnixEpoch < b.createdAt.microsSinceUnixEpoch
            ? -1
            : 1
      )
      .slice(0, Math.min(max, 64));
    const until = ts(t0 + BigInt(Math.max(5, leaseSec)) * MICROS_PER_SEC);
    for (const task of runnable) {
      ctx.db.agentTask.id.update({
        ...task,
        status: 'running',
        leaseOwner: workerId,
        leaseUntil: until,
        attempts: task.attempts + 1,
        updatedAt: ctx.timestamp,
      });
    }
  }
);

export const extendLeases = spacetimedb.reducer(
  { workerId: t.string(), ids: t.array(t.u64()), leaseSec: t.u32() },
  (ctx, { workerId, ids, leaseSec }) => {
    requireEngine(ctx);
    const until = ts(now(ctx) + BigInt(Math.max(5, leaseSec)) * MICROS_PER_SEC);
    for (const id of ids) {
      const task = ctx.db.agentTask.id.find(id);
      if (task && task.status === 'running' && task.leaseOwner === workerId) {
        ctx.db.agentTask.id.update({ ...task, leaseUntil: until, updatedAt: ctx.timestamp });
      }
    }
  }
);

export const completeTask = spacetimedb.reducer(
  {
    id: t.u64(),
    workerId: t.string(),
    result: t.string(),
    usage: TaskUsageInput,
    followups: t.array(TaskInput),
  },
  (ctx, { id, workerId, result, usage, followups }) => {
    requireEngine(ctx);
    const task = ctx.db.agentTask.id.find(id);
    // A worker that lost its lease must not overwrite the new owner's run.
    if (!task || task.status !== 'running' || task.leaseOwner !== workerId) return;
    ctx.db.agentTask.id.update({
      ...task,
      status: 'done',
      result: result.slice(0, 16_000),
      error: '',
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cachedTokens: usage.cachedTokens,
      costUsd: usage.costUsd,
      updatedAt: ctx.timestamp,
    });
    releaseDependents(ctx, id);
    for (const f of followups) enqueueTask(ctx, f);
  }
);

export const failTask = spacetimedb.reducer(
  { id: t.u64(), workerId: t.string(), error: t.string(), retryInSec: t.u32() },
  (ctx, { id, workerId, error, retryInSec }) => {
    requireEngine(ctx);
    const task = ctx.db.agentTask.id.find(id);
    if (!task || task.status !== 'running' || task.leaseOwner !== workerId) return;
    const retry = task.attempts < task.maxAttempts;
    ctx.db.agentTask.id.update({
      ...task,
      status: retry ? 'pending' : 'failed',
      error: error.slice(0, 2000),
      leaseOwner: '',
      notBefore: ts(now(ctx) + BigInt(retryInSec) * MICROS_PER_SEC),
      updatedAt: ctx.timestamp,
    });
    if (!retry) cancelDependents(ctx, id);
  }
);

export const cancelTasks = spacetimedb.reducer({ ids: t.array(t.u64()) }, (ctx, { ids }) => {
  requireEngine(ctx);
  for (const id of ids) {
    const task = ctx.db.agentTask.id.find(id);
    if (!task || TASK_TERMINAL.includes(task.status)) continue;
    ctx.db.agentTask.id.update({ ...task, status: 'cancelled', leaseOwner: '', updatedAt: ctx.timestamp });
    cancelDependents(ctx, id);
  }
});

// ───────────────────────────── telemetry & calibration ─────────────────────────────

export const heartbeat = spacetimedb.reducer(
  { workerId: t.string(), version: t.string(), status: t.string(), inflight: t.u32(), info: t.string() },
  (ctx, args) => {
    requireEngine(ctx);
    const row = {
      workerId: args.workerId,
      identity: ctx.sender,
      lastSeen: ctx.timestamp,
      version: args.version,
      status: args.status,
      inflight: args.inflight,
      info: args.info.slice(0, 2000),
    };
    if (ctx.db.engineHeartbeat.workerId.find(args.workerId)) ctx.db.engineHeartbeat.workerId.update(row);
    else ctx.db.engineHeartbeat.insert(row);
  }
);

export const recordLlmUsage = spacetimedb.reducer({ usages: t.array(LlmUsageInput) }, (ctx, { usages }) => {
  requireEngine(ctx);
  const hour = hourBucket(now(ctx));
  for (const u of usages) {
    const key = `${hour}|${u.model}|${u.route}`;
    const row = ctx.db.llmUsage.key.find(key);
    if (row) {
      ctx.db.llmUsage.key.update({
        ...row,
        calls: row.calls + u.calls,
        tokensIn: row.tokensIn + u.tokensIn,
        tokensOut: row.tokensOut + u.tokensOut,
        cachedTokens: row.cachedTokens + u.cachedTokens,
        thoughtTokens: row.thoughtTokens + u.thoughtTokens,
        costUsd: row.costUsd + u.costUsd,
      });
    } else {
      ctx.db.llmUsage.insert({ key, hour: ts(hour), ...u });
    }
  }
});

export const logActivities = spacetimedb.reducer({ items: t.array(ActivityInput) }, (ctx, { items }) => {
  requireEngine(ctx);
  for (const a of items) logActivity(ctx, a.sessionId, a.level, a.kind, a.message, a.refId);
});

export const addCalibrationSamples = spacetimedb.reducer(
  { samples: t.array(CalibrationSampleInput) },
  (ctx, { samples }) => {
    requireEngine(ctx);
    for (const s of samples) {
      ctx.db.calibrationSample.insert({
        id: 0n,
        ...s,
        prob: clamp(s.prob, 0, 1),
        answer: s.answer.slice(0, 200),
        state: s.state.slice(0, 6000),
        createdAt: ctx.timestamp,
        resolvedAt: s.outcome === undefined ? undefined : ctx.timestamp,
      });
    }
  }
);

export const resolveCalibrationSamples = spacetimedb.reducer(
  { outcomes: t.array(CalibrationOutcomeInput) },
  (ctx, { outcomes }) => {
    requireEngine(ctx);
    for (const o of outcomes) {
      const s = ctx.db.calibrationSample.id.find(o.sampleId);
      if (!s || s.outcome !== undefined) continue;
      ctx.db.calibrationSample.id.update({ ...s, outcome: clamp(o.outcome, 0, 1), resolvedAt: ctx.timestamp });
    }
  }
);

export const upsertCalibrator = spacetimedb.reducer({ cal: CalibratorInput }, (ctx, { cal }) => {
  requireEngine(ctx);
  const row = { ...cal, updatedAt: ctx.timestamp };
  if (ctx.db.calibrator.component.find(cal.component)) ctx.db.calibrator.component.update(row);
  else ctx.db.calibrator.insert(row);
});

// ───────────────────────────── System-1 reflexes ─────────────────────────────

export const upsertReflexes = spacetimedb.reducer({ reflexes: t.array(ReflexInput) }, (ctx, { reflexes }) => {
  requireEngine(ctx);
  for (const r of reflexes) {
    if (!['noul', 'choice', 'score'].includes(r.qtype)) throw new SenderError(`bad qtype ${r.qtype}`);
    if (r.criteriaKeys.length !== r.criteriaText.length) throw new SenderError('criteria keys/text length mismatch');
    const existing = ctx.db.reflex.key.find(r.key);
    const fields = {
      ...r,
      instructions: r.instructions.slice(0, 4000),
      candidateInstructions: r.candidateInstructions.slice(0, 4000),
      coachNote: r.coachNote.slice(0, 2000),
      threshold: clamp(r.threshold, 0, 1),
      candidateThreshold: clamp(r.candidateThreshold, 0, 1),
      updatedAt: ctx.timestamp,
    };
    if (existing) ctx.db.reflex.key.update({ ...existing, ...fields });
    else
      ctx.db.reflex.insert({
        ...fields,
        nFired: 0,
        nResolved: 0,
        brier: 0,
        hitRate: 0,
        avgLatencyMs: 0,
      });
  }
});

export const recordReflexStats = spacetimedb.reducer({ stats: t.array(ReflexStatsInput) }, (ctx, { stats }) => {
  requireEngine(ctx);
  for (const s of stats) {
    const r = ctx.db.reflex.key.find(s.key);
    if (!r) continue;
    ctx.db.reflex.key.update({
      ...r,
      nFired: r.nFired + s.firedDelta,
      nResolved: s.nResolved,
      brier: s.brier,
      hitRate: s.hitRate,
      avgLatencyMs: s.avgLatencyMs,
      updatedAt: ctx.timestamp,
    });
  }
});

// Admins can switch a reflex off (or back on) from the UI.
export const setReflexEnabled = spacetimedb.reducer({ key: t.string(), enabled: t.bool() }, (ctx, { key, enabled }) => {
  requireAdmin(ctx);
  const r = ctx.db.reflex.key.find(key);
  if (!r) throw new SenderError(`no reflex ${key}`);
  ctx.db.reflex.key.update({ ...r, enabled, updatedAt: ctx.timestamp });
});

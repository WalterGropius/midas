// MIDAS — SpacetimeDB schema.
//
// One rule: everything lives here. The engine is a stateless compute nozzle;
// any engine process can die and a new one resumes from these tables.
//
// Planes (graph-engineering reference architecture):
//   control    → session, session_market, seed_file, global_flag, operator
//   execution  → agent_task (the synaptic ledger / task DAG), engine_heartbeat
//   artifact   → signal, agent_forecast, path_forecast, decision, trade_order
//   graph      → mem_node, mem_edge (canonical vs draft, bi-temporal edges)
//   evaluation → decision.verdict/reasons, evolution_trial, agent fitness
import { schema, table, t } from 'spacetimedb/server';

// ───────────────────────────── shared object types ─────────────────────────────

export const RiskConfig = t.object('RiskConfig', {
  // fraction of full Kelly actually bet (0.25 = quarter Kelly)
  kellyFraction: t.f64(),
  // max % of equity in one market
  maxPositionPct: t.f64(),
  // max % of equity deployed across all markets
  maxGrossExposurePct: t.f64(),
  // pause the session when the day's loss exceeds this % of day-start equity
  maxDailyLossPct: t.f64(),
  // kill the session when drawdown from peak exceeds this %
  maxDrawdownPct: t.f64(),
  // minimum edge (prob points, after costs) to open a position
  minEdge: t.f64(),
  // do not trade books wider than this (prob points)
  maxSpread: t.f64(),
  // λ in logit space: weight on the model vs the market price (0 = pure market)
  modelTrust: t.f64(),
  maxOpenPositions: t.u32(),
  // 'reaction' (news shocks) | 'value' (fair value to resolution) | 'both'
  strategy: t.string(),
});

export const IntelConfig = t.object('IntelConfig', {
  // number of Flash forecasters in the swarm per (news, market) pair
  swarmSize: t.u32(),
  // hard cap on Pro deliberations per hour for this session
  proCallsPerHour: t.u32(),
  // escalate to Pro when |edge| exceeds this
  escalateEdge: t.f64(),
  // … or when swarm disagreement (std of log-odds) exceeds this
  escalateDisagreement: t.f64(),
  dailyLlmBudgetUsd: t.f64(),
});

export const SeedFileInput = t.object('SeedFileInput', {
  path: t.string(),
  kind: t.string(), // 'config' | 'schema' | 'raw' | 'wiki'
  content: t.string(),
});

export const SessionMarketInput = t.object('SessionMarketInput', {
  conditionId: t.string(),
  note: t.string(),
  prior: t.option(t.f64()),
});

export const MarketInput = t.object('MarketInput', {
  conditionId: t.string(),
  marketId: t.string(),
  question: t.string(),
  slug: t.string(),
  description: t.string(),
  category: t.string(),
  endDate: t.string(),
  yesTokenId: t.string(),
  noTokenId: t.string(),
  tickSize: t.f64(),
  minOrderSize: t.f64(),
  negRisk: t.bool(),
  eventId: t.string(),
  negRiskMarketId: t.string(),
  outcomeLabel: t.string(),
  feeRate: t.f64(),
  active: t.bool(),
  closed: t.bool(),
  bestBid: t.f64(),
  bestAsk: t.f64(),
  lastPrice: t.f64(),
  volumeDay: t.f64(),
  liquidity: t.f64(),
});

export const PriceBarInput = t.object('PriceBarInput', {
  conditionId: t.string(),
  ts: t.timestamp(),
  open: t.f64(),
  high: t.f64(),
  low: t.f64(),
  close: t.f64(),
  bid: t.f64(),
  ask: t.f64(),
});

export const NewsInput = t.object('NewsInput', {
  hash: t.string(),
  source: t.string(),
  feed: t.string(),
  title: t.string(),
  summary: t.string(),
  url: t.string(),
  publishedAt: t.timestamp(),
  urgency: t.f64(),
});

export const NewsTriageInput = t.object('NewsTriageInput', {
  newsId: t.u64(),
  status: t.string(),
  urgency: t.f64(),
  sentiment: t.f64(),
  novelty: t.f64(),
  eventType: t.string(),
  entities: t.array(t.string()),
  marketIds: t.array(t.string()),
  triageNote: t.string(),
});

export const SignalInput = t.object('SignalInput', {
  ref: t.string(),
  newsId: t.u64(),
  conditionId: t.string(),
  layer: t.string(),
  expectedDelta: t.f64(),
  deltaQ10: t.f64(),
  deltaQ90: t.f64(),
  halfLifeMin: t.f64(),
  probYes: t.f64(),
  probMarket: t.f64(),
  confidence: t.f64(),
  disagreement: t.f64(),
  nAgents: t.u32(),
  rationale: t.string(),
  analogCount: t.u32(),
  analogMeanDelta: t.f64(),
});

export const AgentForecastInput = t.object('AgentForecastInput', {
  agentId: t.u64(),
  probYes: t.f64(),
  expectedDelta: t.f64(),
  halfLifeMin: t.f64(),
  confidence: t.f64(),
  rationale: t.string(),
  latencyMs: t.u32(),
});

export const SignalScoreInput = t.object('SignalScoreInput', {
  signalId: t.u64(),
  realizedShort: t.option(t.f64()),
  realizedMid: t.option(t.f64()),
  realizedLong: t.option(t.f64()),
  absError: t.option(t.f64()),
  final: t.bool(),
});

export const AgentForecastScoreInput = t.object('AgentForecastScoreInput', {
  forecastId: t.u64(),
  brier: t.option(t.f64()),
  reactionErr: t.option(t.f64()),
});

export const PathForecastInput = t.object('PathForecastInput', {
  conditionId: t.string(),
  baseTs: t.timestamp(),
  stepSec: t.u32(),
  lastPrice: t.f64(),
  point: t.array(t.f64()),
  q10: t.array(t.f64()),
  q90: t.array(t.f64()),
  model: t.string(),
  newsAdjusted: t.bool(),
});

export const DecisionInput = t.object('DecisionInput', {
  ref: t.string(),
  sessionId: t.u64(),
  conditionId: t.string(),
  signalRef: t.string(),
  action: t.string(),
  strategy: t.string(),
  fairProb: t.f64(),
  marketPrice: t.f64(),
  edge: t.f64(),
  kellyFraction: t.f64(),
  sizeUsd: t.f64(),
  confirmations: t.u32(),
  confidence: t.f64(),
  verdict: t.string(),
  reasons: t.array(t.string()),
});

export const OrderInput = t.object('OrderInput', {
  ref: t.string(),
  sessionId: t.u64(),
  decisionRef: t.string(),
  conditionId: t.string(),
  tokenId: t.string(),
  outcome: t.string(),
  side: t.string(),
  price: t.f64(),
  size: t.f64(),
  status: t.string(),
  mode: t.string(),
  externalId: t.string(),
  filledSize: t.f64(),
  avgFillPrice: t.f64(),
  feeUsd: t.f64(),
  note: t.string(),
});

export const PositionInput = t.object('PositionInput', {
  sessionId: t.u64(),
  conditionId: t.string(),
  outcome: t.string(),
  shares: t.f64(),
  avgPrice: t.f64(),
  costUsd: t.f64(),
  markPrice: t.f64(),
  unrealizedPnlUsd: t.f64(),
  realizedPnlUsd: t.f64(),
  closed: t.bool(),
  strategy: t.string(),
  targetPrice: t.f64(),
  stopPrice: t.f64(),
  // 0 = no time stop
  timeStopMicros: t.i64(),
});

export const SessionAccountingInput = t.object('SessionAccountingInput', {
  sessionId: t.u64(),
  cashUsd: t.f64(),
  equityUsd: t.f64(),
  peakEquityUsd: t.f64(),
  dayStartEquityUsd: t.f64(),
  realizedPnlUsd: t.f64(),
  feesPaidUsd: t.f64(),
  exposureUsd: t.f64(),
});

export const EquityPointInput = t.object('EquityPointInput', {
  sessionId: t.u64(),
  equityUsd: t.f64(),
  cashUsd: t.f64(),
  exposureUsd: t.f64(),
});

export const AgentInput = t.object('AgentInput', {
  // 0 → insert a new agent
  id: t.u64(),
  name: t.string(),
  generation: t.u32(),
  parentId: t.u64(),
  status: t.string(),
  tier: t.string(),
  niche: t.string(),
  persona: t.string(),
  instructions: t.string(),
  temperature: t.f64(),
  styleTags: t.array(t.string()),
  weight: t.f64(),
  nScored: t.u32(),
  brier: t.f64(),
  logLoss: t.f64(),
  reactionMae: t.f64(),
  directionHit: t.f64(),
  lineageNote: t.string(),
});

export const MemNodeInput = t.object('MemNodeInput', {
  key: t.string(),
  kind: t.string(),
  label: t.string(),
  aliases: t.array(t.string()),
  summary: t.string(),
  sessionId: t.u64(),
  status: t.string(),
  salienceDelta: t.f64(),
  helpfulDelta: t.u32(),
  harmfulDelta: t.u32(),
  // empty array → keep the existing embedding
  embedding: t.array(t.f32()),
});

export const MemEdgeInput = t.object('MemEdgeInput', {
  key: t.string(),
  srcKey: t.string(),
  dstKey: t.string(),
  rel: t.string(),
  weight: t.f64(),
  value: t.f64(),
  lagMin: t.f64(),
  evidence: t.string(),
  sessionId: t.u64(),
  status: t.string(),
});

export const TaskInput = t.object('TaskInput', {
  kind: t.string(),
  sessionId: t.u64(),
  priority: t.i32(),
  // dedupe keys of tasks this one waits on (must already exist)
  dependsOn: t.array(t.string()),
  dedupeKey: t.string(),
  payload: t.string(),
  maxAttempts: t.u32(),
  // 0 → runnable immediately
  notBeforeMicros: t.i64(),
});

export const TaskUsageInput = t.object('TaskUsageInput', {
  model: t.string(),
  tokensIn: t.u32(),
  tokensOut: t.u32(),
  cachedTokens: t.u32(),
  costUsd: t.f64(),
});

export const LlmUsageInput = t.object('LlmUsageInput', {
  route: t.string(),
  model: t.string(),
  calls: t.u32(),
  tokensIn: t.f64(),
  tokensOut: t.f64(),
  cachedTokens: t.f64(),
  thoughtTokens: t.f64(),
  costUsd: t.f64(),
});

export const ActivityInput = t.object('ActivityInput', {
  sessionId: t.u64(),
  level: t.string(),
  kind: t.string(),
  message: t.string(),
  refId: t.string(),
});

export const CalibrationSampleInput = t.object('CalibrationSampleInput', {
  component: t.string(),
  version: t.u32(),
  refId: t.string(),
  prob: t.f64(),
  answer: t.string(),
  state: t.string(),
  outcome: t.option(t.f64()),
});

export const ReflexInput = t.object('ReflexInput', {
  key: t.string(),
  qtype: t.string(),
  instructions: t.string(),
  criteriaKeys: t.array(t.string()),
  criteriaText: t.array(t.string()),
  threshold: t.f64(),
  provider: t.string(),
  version: t.u32(),
  candidateInstructions: t.string(),
  candidateThreshold: t.f64(),
  enabled: t.bool(),
  coachNote: t.string(),
});

export const ReflexStatsInput = t.object('ReflexStatsInput', {
  key: t.string(),
  firedDelta: t.u32(),
  nResolved: t.u32(),
  brier: t.f64(),
  hitRate: t.f64(),
  avgLatencyMs: t.f64(),
});

export const CalibrationOutcomeInput = t.object('CalibrationOutcomeInput', {
  sampleId: t.u64(),
  outcome: t.f64(),
});

export const CalibratorInput = t.object('CalibratorInput', {
  component: t.string(),
  a: t.f64(),
  b: t.f64(),
  n: t.u32(),
  eceBefore: t.f64(),
  eceAfter: t.f64(),
  brierBefore: t.f64(),
  brierAfter: t.f64(),
});

export const TrialInput = t.object('TrialInput', {
  // 'agent:<id>' | 'reflex:<key>'
  subject: t.string(),
  agentId: t.u64(),
  parentId: t.u64(),
  generation: t.u32(),
  baselineScore: t.f64(),
  candidateScore: t.f64(),
  nEval: t.u32(),
  decision: t.string(),
  mutation: t.string(),
  metric: t.string(),
});

// ───────────────────────────────── tables ─────────────────────────────────

// Control plane
const operator = table(
  { name: 'operator', public: true },
  {
    identity: t.identity().primaryKey(),
    role: t.string(), // 'admin' | 'engine'
    createdAt: t.timestamp(),
  }
);

const operatorRequest = table(
  { name: 'operator_request', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    identity: t.identity(),
    role: t.string(),
    status: t.string(), // 'pending' | 'approved' | 'rejected'
    createdAt: t.timestamp(),
  }
);

const globalFlag = table(
  { name: 'global_flag', public: true },
  {
    key: t.string().primaryKey(),
    value: t.string(),
    updatedAt: t.timestamp(),
  }
);

const session = table(
  { name: 'session', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    name: t.string(),
    slug: t.string(),
    // 'running' | 'paused' | 'stopped' | 'killed' | 'pending_approval' | 'archived'
    status: t.string(),
    statusReason: t.string(),
    mode: t.string(), // 'paper' | 'live'
    liveApproved: t.bool(),
    bankrollUsd: t.f64(),
    cashUsd: t.f64(),
    equityUsd: t.f64(),
    peakEquityUsd: t.f64(),
    dayStartEquityUsd: t.f64(),
    realizedPnlUsd: t.f64(),
    feesPaidUsd: t.f64(),
    exposureUsd: t.f64(),
    risk: RiskConfig,
    intel: IntelConfig,
    thesis: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

// The seed folder, stored as rows. kind 'wiki' pages are compiled and kept
// current by the engine (Karpathy-style LLM wiki): raw/ is immutable input,
// wiki/ is the compounding artifact, SCHEMA.md tells agents the conventions.
const seedFile = table(
  { name: 'seed_file', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    path: t.string(),
    kind: t.string(),
    content: t.string(),
    version: t.u32(),
    updatedBy: t.string(), // 'user' | 'engine'
    updatedAt: t.timestamp(),
  }
);

const sessionMarket = table(
  { name: 'session_market', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    conditionId: t.string().index('btree'),
    note: t.string(),
    prior: t.option(t.f64()),
    addedAt: t.timestamp(),
  }
);

// Markets are global: one intelligence pass per market serves every session.
const market = table(
  { name: 'market', public: true },
  {
    conditionId: t.string().primaryKey(),
    marketId: t.string(),
    question: t.string(),
    slug: t.string(),
    description: t.string(),
    category: t.string(),
    endDate: t.string(),
    yesTokenId: t.string(),
    noTokenId: t.string(),
    tickSize: t.f64(),
    minOrderSize: t.f64(),
    negRisk: t.bool(),
    // multi-outcome grouping (for sum-to-one consistency / arbitrage checks)
    eventId: t.string(),
    negRiskMarketId: t.string(),
    outcomeLabel: t.string(),
    // taker fee rate: fee = shares × feeRate × p × (1 − p); makers pay 0
    feeRate: t.f64(),
    active: t.bool(),
    closed: t.bool(),
    resolved: t.bool(),
    outcomeYes: t.option(t.f64()),
    bestBid: t.f64(),
    bestAsk: t.f64(),
    lastPrice: t.f64(),
    volumeDay: t.f64(),
    liquidity: t.f64(),
    updatedAt: t.timestamp(),
  }
);

const priceBar = table(
  { name: 'price_bar', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    conditionId: t.string().index('btree'),
    ts: t.timestamp(),
    open: t.f64(),
    high: t.f64(),
    low: t.f64(),
    close: t.f64(),
    bid: t.f64(),
    ask: t.f64(),
  }
);

const newsItem = table(
  { name: 'news_item', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    hash: t.string().unique(),
    source: t.string(),
    feed: t.string(),
    title: t.string(),
    summary: t.string(),
    url: t.string(),
    publishedAt: t.timestamp(),
    ingestedAt: t.timestamp(),
    // 'new' | 'triaged' | 'irrelevant' | 'escalated'
    status: t.string().index('btree'),
    urgency: t.f64(),
    sentiment: t.f64(),
    novelty: t.f64(),
    eventType: t.string(),
    entities: t.array(t.string()),
    marketIds: t.array(t.string()),
    triageNote: t.string(),
  }
);

// Artifact plane: a reaction forecast for one (news, market) pair.
const signal = table(
  { name: 'signal', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    ref: t.string().unique(),
    newsId: t.u64().index('btree'),
    conditionId: t.string().index('btree'),
    createdAt: t.timestamp(),
    layer: t.string(), // 'swarm' | 'pro'
    expectedDelta: t.f64(),
    deltaQ10: t.f64(),
    deltaQ90: t.f64(),
    halfLifeMin: t.f64(),
    probYes: t.f64(),
    probMarket: t.f64(),
    confidence: t.f64(),
    disagreement: t.f64(),
    nAgents: t.u32(),
    rationale: t.string(),
    analogCount: t.u32(),
    analogMeanDelta: t.f64(),
    realizedShort: t.option(t.f64()),
    realizedMid: t.option(t.f64()),
    realizedLong: t.option(t.f64()),
    absError: t.option(t.f64()),
    status: t.string(), // 'open' | 'scored'
  }
);

const agentForecast = table(
  { name: 'agent_forecast', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    signalId: t.u64().index('btree'),
    agentId: t.u64().index('btree'),
    conditionId: t.string(),
    createdAt: t.timestamp(),
    probYes: t.f64(),
    expectedDelta: t.f64(),
    halfLifeMin: t.f64(),
    confidence: t.f64(),
    rationale: t.string(),
    latencyMs: t.u32(),
    brier: t.option(t.f64()),
    reactionErr: t.option(t.f64()),
  }
);

const pathForecast = table(
  { name: 'path_forecast', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    conditionId: t.string().index('btree'),
    createdAt: t.timestamp(),
    baseTs: t.timestamp(),
    stepSec: t.u32(),
    lastPrice: t.f64(),
    point: t.array(t.f64()),
    q10: t.array(t.f64()),
    q90: t.array(t.f64()),
    model: t.string(),
    newsAdjusted: t.bool(),
  }
);

// Evaluation plane: every trade decision with its evaluator verdict.
const decision = table(
  { name: 'decision', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    ref: t.string().unique(),
    sessionId: t.u64().index('btree'),
    conditionId: t.string(),
    signalRef: t.string(),
    createdAt: t.timestamp(),
    action: t.string(),
    strategy: t.string(),
    fairProb: t.f64(),
    marketPrice: t.f64(),
    edge: t.f64(),
    kellyFraction: t.f64(),
    sizeUsd: t.f64(),
    confirmations: t.u32(),
    confidence: t.f64(),
    verdict: t.string(), // 'approved' | 'rejected'
    reasons: t.array(t.string()),
  }
);

// "order" is an SQL keyword, hence trade_order.
const tradeOrder = table(
  { name: 'trade_order', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    ref: t.string().unique(),
    sessionId: t.u64().index('btree'),
    decisionRef: t.string(),
    conditionId: t.string(),
    tokenId: t.string(),
    outcome: t.string(), // 'YES' | 'NO'
    side: t.string(), // 'BUY' | 'SELL'
    price: t.f64(),
    size: t.f64(),
    // 'pending' | 'open' | 'filled' | 'partial' | 'cancelled' | 'rejected'
    status: t.string(),
    mode: t.string(),
    externalId: t.string(),
    filledSize: t.f64(),
    avgFillPrice: t.f64(),
    feeUsd: t.f64(),
    note: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const position = table(
  { name: 'position', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    conditionId: t.string(),
    outcome: t.string(),
    shares: t.f64(),
    avgPrice: t.f64(),
    costUsd: t.f64(),
    markPrice: t.f64(),
    unrealizedPnlUsd: t.f64(),
    realizedPnlUsd: t.f64(),
    closed: t.bool(),
    strategy: t.string(),
    targetPrice: t.f64(),
    stopPrice: t.f64(),
    timeStopMicros: t.i64(),
    openedAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const equityPoint = table(
  { name: 'equity_point', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    ts: t.timestamp(),
    equityUsd: t.f64(),
    cashUsd: t.f64(),
    exposureUsd: t.f64(),
  }
);

// The evolving population. instructions is the mutable "genome".
const agent = table(
  { name: 'agent', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    generation: t.u32(),
    parentId: t.u64(),
    status: t.string().index('btree'), // 'active' | 'candidate' | 'retired'
    tier: t.string(), // 'flash' | 'pro'
    niche: t.string(),
    persona: t.string(),
    instructions: t.string(),
    temperature: t.f64(),
    styleTags: t.array(t.string()),
    weight: t.f64(),
    nScored: t.u32(),
    brier: t.f64(),
    logLoss: t.f64(),
    reactionMae: t.f64(),
    directionHit: t.f64(),
    lineageNote: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const evolutionTrial = table(
  { name: 'evolution_trial', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    subject: t.string(),
    agentId: t.u64(),
    parentId: t.u64(),
    generation: t.u32(),
    baselineScore: t.f64(),
    candidateScore: t.f64(),
    nEval: t.u32(),
    decision: t.string(), // 'kept' | 'reverted' | 'crash'
    mutation: t.string(),
    metric: t.string(),
    createdAt: t.timestamp(),
  }
);

// Graph plane. Node keys are canonical ('entity:federal-reserve',
// 'market:0xabc…', 'event:news-123', 'lesson:…'). sessionId 0 = global memory.
const memNode = table(
  { name: 'mem_node', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(),
    kind: t.string().index('btree'),
    label: t.string(),
    aliases: t.array(t.string()),
    summary: t.string(),
    sessionId: t.u64(),
    status: t.string(), // 'draft' | 'canonical' | 'retracted' | 'merged'
    salience: t.f64(),
    mentionCount: t.u32(),
    // ACE-style playbook counters for lessons: credited only by ground truth
    helpful: t.u32(),
    harmful: t.u32(),
    embedding: t.array(t.f32()),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

// Bi-temporal edges: validFrom = when the fact became true in the world,
// createdAt = when we learned it, invalidatedAt = when it stopped being true.
const memEdge = table(
  { name: 'mem_edge', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    key: t.string().unique(),
    src: t.u64().index('btree'),
    dst: t.u64().index('btree'),
    rel: t.string(),
    weight: t.f64(),
    // numeric payload, e.g. realized Δprob for 'moved' edges
    value: t.f64(),
    lagMin: t.f64(),
    evidence: t.string(),
    sessionId: t.u64(),
    status: t.string(),
    createdAt: t.timestamp(),
    validFrom: t.timestamp(),
    invalidatedAt: t.option(t.timestamp()),
  }
);

// Execution plane: the synaptic ledger. Workers (any number of engine
// processes) claim runnable tasks under a lease; completion cascades to
// dependents. Nothing is lost when rate limits hit — tasks just wait.
const agentTask = table(
  { name: 'agent_task', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    dedupeKey: t.string().unique(),
    kind: t.string(),
    sessionId: t.u64(),
    // 'blocked' | 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
    status: t.string().index('btree'),
    priority: t.i32(),
    deps: t.array(t.u64()),
    payload: t.string(),
    result: t.string(),
    error: t.string(),
    attempts: t.u32(),
    maxAttempts: t.u32(),
    leaseOwner: t.string(),
    leaseUntil: t.timestamp(),
    notBefore: t.timestamp(),
    model: t.string(),
    tokensIn: t.u32(),
    tokensOut: t.u32(),
    cachedTokens: t.u32(),
    costUsd: t.f64(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const llmUsage = table(
  { name: 'llm_usage', public: true },
  {
    key: t.string().primaryKey(),
    hour: t.timestamp(),
    route: t.string(),
    model: t.string(),
    calls: t.u32(),
    tokensIn: t.f64(),
    tokensOut: t.f64(),
    cachedTokens: t.f64(),
    thoughtTokens: t.f64(),
    costUsd: t.f64(),
  }
);

const engineHeartbeat = table(
  { name: 'engine_heartbeat', public: true },
  {
    workerId: t.string().primaryKey(),
    identity: t.identity(),
    lastSeen: t.timestamp(),
    version: t.string(),
    status: t.string(),
    inflight: t.u32(),
    info: t.string(),
  }
);

const activity = table(
  { name: 'activity', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    sessionId: t.u64().index('btree'),
    ts: t.timestamp(),
    level: t.string(),
    kind: t.string(),
    message: t.string(),
    refId: t.string(),
  }
);

// Every probabilistic component (System-1 decision models, swarm consensus,
// individual agents) logs (prob, outcome) pairs here; the engine fits a
// Platt/temperature calibrator per component and stores it in `calibrator`.
const calibrationSample = table(
  { name: 'calibration_sample', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    // e.g. 'reflex:news.relevance', 'consensus:reaction', 'agent:12'
    component: t.string().index('btree'),
    // version of the reflex/agent that produced the sample
    version: t.u32(),
    refId: t.string(),
    prob: t.f64(),
    // the raw typed answer (choice key / score) for non-binary reflexes
    answer: t.string(),
    // truncated input snapshot so the coach can replay candidates offline
    state: t.string(),
    outcome: t.option(t.f64()),
    createdAt: t.timestamp(),
    resolvedAt: t.option(t.timestamp()),
  }
);

// System-1 reflexes: typed, calibrated fast decisions (Jev / Laya / fallback)
// fired at many levels of the loop. The definition (instructions, criteria,
// threshold) is tuned on a slow timescale by the Gemini Pro coach — the
// skateboarder's cortex tweaking the cerebellum.
const reflex = table(
  { name: 'reflex', public: true },
  {
    key: t.string().primaryKey(), // e.g. 'news.relevance'
    qtype: t.string(), // 'noul' | 'choice' | 'score'
    instructions: t.string(),
    // choice → keys + descriptions; score → ordered level descriptions
    criteriaKeys: t.array(t.string()),
    criteriaText: t.array(t.string()),
    // act when calibrated probability ≥ threshold (noul) / choice prob ≥ threshold
    threshold: t.f64(),
    provider: t.string(), // 'jev' | 'laya' | 'flash' | 'heuristic'
    version: t.u32(),
    // the candidate being trialled by the coach (empty when none)
    candidateInstructions: t.string(),
    candidateThreshold: t.f64(),
    nFired: t.u32(),
    nResolved: t.u32(),
    brier: t.f64(),
    hitRate: t.f64(),
    avgLatencyMs: t.f64(),
    enabled: t.bool(),
    coachNote: t.string(),
    updatedAt: t.timestamp(),
  }
);

const calibrator = table(
  { name: 'calibrator', public: true },
  {
    component: t.string().primaryKey(),
    // calibrated = sigmoid(a * logit(p) + b)
    a: t.f64(),
    b: t.f64(),
    n: t.u32(),
    eceBefore: t.f64(),
    eceAfter: t.f64(),
    brierBefore: t.f64(),
    brierAfter: t.f64(),
    updatedAt: t.timestamp(),
  }
);

// Scheduled housekeeping: lease reaping + retention.
const housekeepingTimer = table(
  { name: 'housekeeping_timer' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    job: t.string(),
  }
);

const spacetimedb = schema({
  operator,
  operatorRequest,
  globalFlag,
  session,
  seedFile,
  sessionMarket,
  market,
  priceBar,
  newsItem,
  signal,
  agentForecast,
  pathForecast,
  decision,
  tradeOrder,
  position,
  equityPoint,
  agent,
  evolutionTrial,
  memNode,
  memEdge,
  agentTask,
  llmUsage,
  engineHeartbeat,
  activity,
  calibrationSample,
  calibrator,
  reflex,
  housekeepingTimer,
});

export default spacetimedb;
export { housekeepingTimer };

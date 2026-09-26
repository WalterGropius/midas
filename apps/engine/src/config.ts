// Engine configuration — every knob comes from the environment (see
// .env.example at the repo root). Secrets never touch SpacetimeDB.
import os from 'node:os';

function str(name: string, dflt = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : v;
}

function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(name: string, dflt: string[]): string[] {
  const v = process.env[name];
  if (!v) return dflt;
  return v
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export const config = {
  version: '0.1.0',
  workerId: str('MIDAS_WORKER_ID', `${os.hostname()}-${process.pid}`),
  // 'all' = leader loops + task workers; 'leader' = ingest/markets/scheduler/portfolio
  // only; 'worker' = ledger task execution only (scale these horizontally on Modal)
  role: (['all', 'leader', 'worker'].includes(str('MIDAS_ROLE', 'all')) ? str('MIDAS_ROLE', 'all') : 'all') as
    | 'all'
    | 'leader'
    | 'worker',

  stdb: {
    uri: str('MIDAS_STDB_URI', 'ws://127.0.0.1:3000'),
    database: str('MIDAS_STDB_DB', 'midas'),
    // On Modal set MIDAS_STDB_TOKEN (a stable identity across container restarts);
    // locally the token is persisted to a file after the first connect.
    token: str('MIDAS_STDB_TOKEN'),
    tokenFile: str('MIDAS_STDB_TOKEN_FILE', '.midas-engine-token'),
  },

  gemini: {
    apiKey: str('GEMINI_API_KEY', str('GOOGLE_API_KEY')),
    // optional: point the native Gemini client at a proxy (or a local mock in tests)
    baseUrl: str('MIDAS_GEMINI_BASE_URL'),
    // how Gemini is reached: 'auto' = GEMINI_API_KEY if set, else Vercel AI
    // Gateway; 'direct' or 'gateway' force one
    via: str('MIDAS_GEMINI_VIA', 'auto') as 'auto' | 'direct' | 'gateway',
    // Model ids move fast; override without code changes.
    flash: str('MIDAS_GEMINI_FLASH', 'gemini-3.8-flash'),
    flashLite: str('MIDAS_GEMINI_FLASH_LITE', 'gemini-3.5-flash-lite'),
    pro: str('MIDAS_GEMINI_PRO', 'gemini-3.1-pro-preview'),
    embed: str('MIDAS_GEMINI_EMBED', 'gemini-embedding-2'),
    embedDims: num('MIDAS_GEMINI_EMBED_DIMS', 768),
    // USD per 1M tokens (input, cached input, output) — keep in sync with Google's pricing page.
    price: {
      // gemini-3.8-flash promo pricing until 2026-12-31 (then 1.50 / 0.15 / 7.50)
      flash: [num('MIDAS_PRICE_FLASH_IN', 0.75), num('MIDAS_PRICE_FLASH_CACHED', 0.075), num('MIDAS_PRICE_FLASH_OUT', 3.75)],
      flashLite: [num('MIDAS_PRICE_LITE_IN', 0.3), num('MIDAS_PRICE_LITE_CACHED', 0.03), num('MIDAS_PRICE_LITE_OUT', 2.5)],
      pro: [num('MIDAS_PRICE_PRO_IN', 2), num('MIDAS_PRICE_PRO_CACHED', 0.2), num('MIDAS_PRICE_PRO_OUT', 12)],
      embed: [num('MIDAS_PRICE_EMBED_IN', 0.2), 0, 0],
    } as Record<string, [number, number, number]>,
    maxConcurrent: num('MIDAS_GEMINI_CONCURRENCY', 16),
    // other model families mixed into the swarm for independent errors
    // (AI Gateway ids like anthropic/claude-sonnet-5 when AI_GATEWAY_API_KEY
    // is set, else OpenRouter ids)
    altModels: list('MIDAS_ALT_MODELS', []),
    globalDailyBudgetUsd: num('MIDAS_LLM_DAILY_BUDGET_USD', 25),
  },

  // Vercel AI Gateway: one key reaches Jev, Gemini (when there is no
  // GEMINI_API_KEY) and any other model family for the swarm, with spend and
  // traces in one dashboard.
  gateway: {
    apiKey: str('AI_GATEWAY_API_KEY'),
    baseUrl: str('MIDAS_GATEWAY_URL', 'https://ai-gateway.vercel.sh'),
    // server-side web search for grounded calls: perplexity | exa | parallel | tako | none
    search: str('MIDAS_GATEWAY_SEARCH', 'perplexity'),
  },

  // System-1 decision models (Jev / Laya). 'auto' = first configured of
  // jev → jev-gateway → jev-openrouter → laya → flash → heuristic.
  s1: {
    provider: str('MIDAS_S1_PROVIDER', 'auto'),
    // All three speak the same "System One" wire protocol (POST …/v1/systemone).
    jevApiKey: str('TYPESAFE_API_KEY'),
    jevBaseUrl: str('MIDAS_JEV_BASE_URL', 'https://api.typesafe.ai'),
    jevModel: str('MIDAS_JEV_MODEL', 'jev-latest'),
    openRouterKey: str('OPENROUTER_API_KEY'),
    openRouterJevModel: str('MIDAS_OPENROUTER_JEV_MODEL', '~typesafe/jev-latest'),
    gatewayJevModel: str('MIDAS_GATEWAY_JEV_MODEL', 'typesafe-ai/jev'),
    // self-hosted Laya: `laya-serve` or the MIDAS intel sidecar (defaults to MIDAS_MODAL_URL)
    layaBaseUrl: str('MIDAS_LAYA_URL', str('MIDAS_MODAL_URL')),
    layaApiKey: str('MIDAS_LAYA_API_KEY', str('MIDAS_MODAL_TOKEN')),
    maxConcurrent: num('MIDAS_S1_CONCURRENCY', 32),
    timeoutMs: num('MIDAS_S1_TIMEOUT_MS', 4000),
  },

  modal: {
    url: str('MIDAS_MODAL_URL'),
    token: str('MIDAS_MODAL_TOKEN'),
    timeoutMs: num('MIDAS_MODAL_TIMEOUT_MS', 30_000),
  },

  polymarket: {
    gammaUrl: str('MIDAS_GAMMA_URL', 'https://gamma-api.polymarket.com'),
    clobUrl: str('MIDAS_CLOB_URL', 'https://clob.polymarket.com'),
    wsUrl: str('MIDAS_CLOB_WS_URL', 'wss://ws-subscriptions-clob.polymarket.com/ws/market'),
    dataApiUrl: str('MIDAS_DATA_API_URL', 'https://data-api.polymarket.com'),
    // fallback when a market carries no feeSchedule (Fee Structure V2 default)
    defaultFeeRate: num('MIDAS_DEFAULT_TAKER_FEE_RATE', 0.05),
  },

  // Live trading is triple-gated: this flag, a per-session admin approval in
  // SpacetimeDB, and the hard caps below. Paper trading needs none of it.
  live: {
    enabled: bool('MIDAS_LIVE_TRADING', false),
    privateKey: str('POLYMARKET_PRIVATE_KEY'),
    funder: str('POLYMARKET_FUNDER'),
    // 0 EOA, 1 POLY_PROXY, 2 POLY_GNOSIS_SAFE, 3 POLY_1271 (deposit wallet, accounts since 2026-05-04)
    signatureType: num('POLYMARKET_SIGNATURE_TYPE', 3),
    // hard research-backed gate: refuse live orders until the paper track record qualifies
    requireReadiness: bool('MIDAS_LIVE_REQUIRE_READINESS', true),
    maxOrderUsd: num('MIDAS_LIVE_MAX_ORDER_USD', 25),
    maxSessionBankrollUsd: num('MIDAS_LIVE_MAX_BANKROLL_USD', 500),
  },

  // Bidirectional connectors. Everything inbound becomes a SpacetimeDB reducer
  // call, so the UI, Telegram, webhooks and agents share one audit trail.
  connectors: {
    httpPort: num('MIDAS_HTTP_PORT', num('PORT', 8080)),
    // bearer token for the engine control API (required for every write route)
    controlToken: str('MIDAS_CONTROL_TOKEN'),
    telegramToken: str('TELEGRAM_BOT_TOKEN'),
    // comma-separated chat ids allowed to command the engine
    telegramChats: list('TELEGRAM_ALLOWED_CHATS', []),
    discordWebhook: str('DISCORD_WEBHOOK_URL'),
    slackWebhook: str('SLACK_WEBHOOK_URL'),
    // generic JSON webhooks receiving every alert (comma-separated)
    webhooks: list('MIDAS_WEBHOOKS', []),
    // alert levels to push out: trade, risk, lesson, evolution, error
    alertKinds: list('MIDAS_ALERT_KINDS', ['trade', 'risk', 'error']),
  },

  venues: {
    manifoldApiKey: str('MANIFOLD_API_KEY'),
    manifoldUrl: str('MIDAS_MANIFOLD_URL', 'https://api.manifold.markets/v0'),
    kalshiUrl: str('MIDAS_KALSHI_URL', 'https://api.elections.kalshi.com/trade-api/v2'),
  },

  feeds: {
    pollSec: num('MIDAS_RSS_POLL_SEC', 30),
    extra: list('MIDAS_RSS_EXTRA', []),
    userAgent: str('MIDAS_HTTP_UA', 'Mozilla/5.0 (compatible; MIDAS/0.1; +https://github.com/waltergropius/midas)'),
    maxAgeMin: num('MIDAS_NEWS_MAX_AGE_MIN', 180),
  },

  loops: {
    heartbeatSec: num('MIDAS_HEARTBEAT_SEC', 10),
    marketRefreshSec: num('MIDAS_MARKET_REFRESH_SEC', 60),
    markSec: num('MIDAS_MARK_SEC', 20),
    forecastEveryMin: num('MIDAS_FORECAST_EVERY_MIN', 10),
    forecastHorizonSteps: num('MIDAS_FORECAST_HORIZON', 24),
    forecastStepSec: num('MIDAS_FORECAST_STEP_SEC', 300),
    scoreEverySec: num('MIDAS_SCORE_EVERY_SEC', 60),
    calibrateEveryMin: num('MIDAS_CALIBRATE_EVERY_MIN', 30),
    wikiEveryMin: num('MIDAS_WIKI_EVERY_MIN', 20),
    dreamEveryMin: num('MIDAS_DREAM_EVERY_MIN', 60),
    evolveEveryMin: num('MIDAS_EVOLVE_EVERY_MIN', 90),
    coachEveryMin: num('MIDAS_COACH_EVERY_MIN', 60),
  },

  workers: {
    // concurrency per task kind — the parallelism knob
    triage: num('MIDAS_WORKERS_TRIAGE', 4),
    swarm: num('MIDAS_WORKERS_SWARM', 6),
    deliberate: num('MIDAS_WORKERS_DELIBERATE', 2),
    decide: num('MIDAS_WORKERS_DECIDE', 4),
    background: num('MIDAS_WORKERS_BACKGROUND', 2),
    leaseSec: num('MIDAS_LEASE_SEC', 120),
  },

  intel: {
    maxActiveAgents: num('MIDAS_MAX_ACTIVE_AGENTS', 12),
    // recalibration slope applied to pooled log-odds before blending (≈1.5, refit from data)
    extremize: num('MIDAS_EXTREMIZE', 1.5),
    trim: num('MIDAS_TRIM', 0.1),
    // reflex quick-trade: act on System 1 before deliberation finishes
    reflexTrades: bool('MIDAS_REFLEX_TRADES', true),
    reflexStakeFrac: num('MIDAS_REFLEX_STAKE_FRAC', 0.25),
    // one swarm call first so the others hit Gemini's implicit prefix cache
    warmCacheFirst: bool('MIDAS_SWARM_WARM_CACHE', true),
  },
};

export type Config = typeof config;

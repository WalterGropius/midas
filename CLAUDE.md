# MIDAS — rules for coding agents

MIDAS is a self-hosted, open-source prediction-market trading harness:
news → System-1 reflexes (Jev/Laya) → Gemini Flash swarm → Gemini Pro
supervisor → deterministic decision/evaluation plane → paper or live orders on
Polymarket, with graph memory, calibration, and self-evolution. Deployment
target: **Vercel** (static UI) + **Modal** (engine + GPU models) +
**SpacetimeDB Maincloud** (all state). Read `docs/ARCHITECTURE.md` first.

## Hard rules

1. **Everything lives in SpacetimeDB.** No Redis, Postgres, vector DB, queue
   service or local state files. The engine is stateless: any process can die
   and another resumes from the tables. Vectors are `t.array(t.f32())` columns,
   queues are the `agent_task` ledger, schedules are scheduled tables or the
   engine scheduler with time-bucketed dedupe keys.
2. **Reducers are deterministic.** No `Date.now()`, `Math.random()`, network or
   filesystem inside `spacetimedb/src`. Time is `ctx.timestamp`, randomness is
   `ctx.random`. Reducers return nothing — clients read via subscriptions.
3. **Money safety is code, not prompts.** Risk limits, circuit breakers, the
   live-trading triple gate (`MIDAS_LIVE_TRADING`, per-session admin approval,
   readiness gate) and hard caps live in `packages/core/src/risk.ts`,
   `apps/engine/src/trade/*`. Never let an LLM output bypass them. Never
   weaken a gate to make a test pass.
4. **Memory is a hint.** Anything read from memory or the cache is re-verified
   before acting: every order is sized against a book fetched from the venue
   moments before (`hub.freshBook`).
5. **Only ground truth teaches.** Fitness, calibration, lesson credit and
   reflex coaching update only from realized prices or resolutions — never
   from another model's opinion.
6. **Replays are point-in-time.** Evolution and coaching replays must pass
   `asOfMs` to graph retrieval so candidates cannot see the future.
7. **Read-modify-write happens inside a reducer.** The engine's cache can be
   stale and several workers run at once, so never compute a new balance or
   share count client-side and write it back. Fills go through `bookFill`,
   marks through `markToMarket`; decisions are serialized per session
   (`keyedMutex` in `trade/decide.ts`).

## SpacetimeDB 2.x (TypeScript) — verified API, do not invent others

- Module: `table(OPTIONS, COLUMNS)`; `schema({ a, b })` with ONE object;
  `export const name = spacetimedb.reducer({ args }, (ctx, args) => …)` — the
  export name is the reducer name. Entry file re-exports the schema default.
- Auto-inc insert needs `id: 0n`; `insert` returns the row. `u64`/`i64` are
  `bigint`. Update = spread the existing row. Index accessor = column name.
- Client: `DbConnection.builder().withUri().withDatabaseName().withToken()`,
  `conn.reducers.fooBar({ ...object })` (object syntax, returns a Promise),
  React: `useTable(tables.x)` returns `[rows, ready]` (`ready` = the
  subscription has loaded). A reducer's promise resolves after its transaction
  is applied to the client cache.
- **Gotcha (SDK 2.10):** unique non-PK columns are typed as ranged indexes but
  the runtime exposes only `find`. Use `byUnique()` from
  `apps/engine/src/util/rows.ts`. Primary keys: `.find()` works.
- **Gotcha:** client-side index lookups are full scans — cache hot paths
  (see the price-bar cache in `apps/engine/src/market/hub.ts`).
- **Gotcha:** column names with a digit followed by letters become camel-cased
  oddly in bindings (`x2h` → `x2H`). Avoid digits in column names.
- After any schema change: `npm run stdb:publish:local` (add
  `--delete-data=always` for breaking changes) and `npm run stdb:generate`.
  Never edit `packages/stdb-bindings/src` by hand.

## Gemini (verified 2026-09)

- Models: Flash `gemini-3.8-flash`, Flash-Lite `gemini-3.5-flash-lite`, Pro
  `gemini-3.1-pro-preview`, embeddings `gemini-embedding-2` (no `taskType`;
  one `{parts:[{text}]}` per text or they merge into one vector). All are
  env-configurable — never hard-code a model id elsewhere.
- Gemini 3: leave temperature unset (1.0); use `thinkingLevel`, never together
  with `thinkingBudget`. Search grounding + JSON output compose.
- **Byte-stable prefixes.** System prompts in `apps/engine/src/llm/prompts.ts`
  are constants — never interpolate dates, ids or session data into them.
  Shared context goes first in the user turn, agent-specific text last, so
  swarm members share one implicitly cached prefix (≥4,096 tokens to qualify on
  3.x). Watch the `[cache]` log line and the `llm_usage` table.

## Polymarket (verified 2026-09)

- CLOB **V2** since 2026-04-28 (pUSD collateral). Use
  `@polymarket/clob-client-v2` with a viem signer; the V1 client is dead.
- `/book`: bids ascending and asks descending — best is LAST. Normalize.
- WebSocket keepalive: send text `PING` every 10 s; first book arrives as an array.
- Taker fee = `shares × feeRate × p × (1 − p)` (per-market `feeSchedule.rate`);
  makers pay 0.

## Forecasting method (research-backed; see docs/RESEARCH.md)

- Forecasters are **blind** to the market price; combine by formula
  (log-odds pooling, calibration, then blend with the market at weight ≈0.25).
  Never aggregate forecasts with an LLM.
- News impact is a **log-odds shift** (log likelihood ratio);
  `deltaFromShift(p0, shift)` converts it to a price move.
- Trade gates: edge > half-spread + fee + minEdge + 1.5× ensemble spread;
  skip if ≥50% of the predicted move already happened; value trades only for
  prices in [0.15, 0.85], ≥72 h from resolution, never buy under 10¢.

## Workflow

- `npm test` (core math, 35+ tests) and `npm run typecheck` must pass.
- Keep `packages/core` pure (no I/O) and tested; put I/O in `apps/engine`.
- Match the surrounding style: small modules, a header comment saying why the
  module exists, comments only where the reason is not obvious.

# MIDAS

**A self-hosted, open-source, multi-agent trading harness for prediction
markets.** It reads the news as it breaks, predicts how each market will react,
sizes trades with calibrated probabilities and hard risk limits, and gets
better from every outcome.

> Status: v0.1 — paper trading end to end; live trading exists behind a
> deliberately hard triple gate. Nothing here is financial advice. Most live
> LLM trading experiments to date have lost money (see
> [docs/RESEARCH.md](docs/RESEARCH.md)); MIDAS is built to find out honestly
> whether an edge exists before risking capital.

**2-minute explainer:** [`docs/explainer/`](docs/explainer/) — a motion
graphic of the architecture, the target markets and a $500 × 6-month scenario
model built on MIDAS's own sizing code.

## What it does

1. **You bring money, markets and a seed folder.** Onboarding asks for a
   bankroll, a risk preset, the Polymarket markets you care about, your thesis
   and sources, and compiles them into a seed folder (an "LLM wiki": `raw/`
   you own, `wiki/` the agents keep compiling).
2. **It reads the news.** Bloomberg, WSJ, CNBC, Fed, SEC, ECB, BBC, FT and
   more (verified live feeds), plus anything you push via HTTP or Telegram.
3. **System 1 reacts in milliseconds.** Jev or Laya decision models (or
   fallbacks) fire typed, calibrated reflexes over every headline × market
   pair in parallel: relevant? which direction? how urgent? new? — and can
   take a small reflex position before the slow thinking finishes.
4. **System 2 thinks in seconds.** A diverse Gemini Flash swarm forecasts
   blind to the market price (fair value, news impact as a log-odds shift,
   reaction half-life); a Gemini Pro supervisor resolves disagreements with
   search, faces an adversarial critic and a groundedness check. Everything is
   combined by formula, calibrated, and blended with the market price.
5. **A deterministic evaluator decides.** Reaction and value strategies,
   research-backed gates (already-priced, fees, spread, ensemble agreement,
   independent confirmations), fractional Kelly on fresh order books,
   per-market / cluster / gross limits, circuit breakers, kill switch.
6. **It learns on slow timescales.** Realized reactions become graph memory
   and an empirical prior for similar news; forecasters evolve through a
   GEPA-style keep-or-revert ratchet; a Pro "coach" rewrites System-1 reflexes
   from their misfires (the skateboarder loop); lessons are credited only by
   ground truth.

Parallel sessions (each with its own bankroll, markets, risk and seed folder)
share one intelligence layer and one live dashboard.

## Stack

| | |
|---|---|
| State & realtime | **SpacetimeDB** 2.10 (Maincloud) — 28 tables, 52 reducers, task-ledger DAG, graph memory |
| UI | **Next.js 16** static export on **Vercel** — talks to SpacetimeDB directly |
| Compute | **Modal** — always-on Node engine + scale-to-zero GPU models |
| System 2 | **Gemini** 3.8 Flash (swarm, triage, wiki) · 3.1 Pro (supervisor, evolution, coach) · embeddings 2 — direct or via **Vercel AI Gateway** |
| System 1 | **Jev** (TypeSafe, direct or via AI Gateway) · **Laya** (Convai, self-hosted on Modal) · Flash-Lite / heuristic fallback |
| Forecasting | **TimesFM 2.5** on Modal (baseline + volatility band), logit-space |
| Markets | **Polymarket** (Gamma, CLOB V2, WebSocket), Manifold (play-money sandbox), Kalshi (read-only) |
| Connectors | HTTP control API, MCP server (Claude/agents drive MIDAS as tools), Telegram (commands + alerts), Discord/Slack/webhooks |

## Repository

```
spacetimedb/          SpacetimeDB module (schema + reducers)
packages/core/        pure, tested math: aggregation, calibration, Kelly, risk,
                      graph PPR, reaction model, reflexes, evolution, seed folders
packages/stdb-bindings/  generated client bindings
apps/engine/          the harness (Node): ingest → reflexes → swarm → supervisor
                      → decide → execute → score → learn
apps/web/             static Next.js UI
modal/                TimesFM + Laya service, engine host on Modal
seeds/                example seed folder
docs/                 ARCHITECTURE · RESEARCH · DEPLOY · research reports
```

## Quick start (local)

```bash
npm install
curl -sSf https://install.spacetimedb.com | sh && spacetime start   # local DB on :3000
npm run stdb:publish:local
cp .env.example .env            # set AI_GATEWAY_API_KEY (one key: Gemini + Jev), or GEMINI_API_KEY
npm run seed:import -- seeds/example-macro-geopolitics
npm run engine                  # engine + control API on :8080
npm run web                     # UI on http://localhost:3001
```

One `AI_GATEWAY_API_KEY` is enough: Vercel AI Gateway serves Jev, Gemini,
embeddings and any second model family. Without any model key the engine
still ingests news, streams prices, fires heuristic reflexes, writes graph
memory and forecasts price paths — the swarm and supervisor stay idle.

Deploying to your own Vercel + Modal + SpacetimeDB accounts:
[docs/DEPLOY.md](docs/DEPLOY.md).

## Safety model

- **Paper by default.** Paper fills walk the real order book and pay the real
  taker fee (`shares × rate × p(1−p)`); maker orders fill only when the market
  trades through them.
- **Live needs three keys:** `MIDAS_LIVE_TRADING=true`, an admin approval per
  session, and the readiness gate (≥300 resolved forecasts, Brier below the
  market, ECE < 0.05, paper PnL 95% CI > 0) — plus per-order and per-session
  USD caps.
- **Money rules are code.** Limits, breakers and gates live in
  `packages/core/src/risk.ts` and `apps/engine/src/trade/`; no prompt, agent
  or evolution step can change them.
- **Global halt** from the UI, Telegram (`/halt`) or `POST /api/halt`.

## Tests

```bash
npm test          # core math (35) + engine parsers (7)
npm run typecheck
python -m pytest modal/test_core_math.py   # intel service math (73)
```

## License

Not yet chosen — see the pull request that introduced this code.

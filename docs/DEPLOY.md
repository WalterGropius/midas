# Deploy MIDAS on your own accounts

Target: **SpacetimeDB Maincloud** (state) + **Modal** (engine and GPU models)
+ **Vercel** (static UI). Everything runs on your accounts with your keys.
Paper trading needs no wallet.

## 0. Prerequisites

```bash
curl -sSf https://install.spacetimedb.com | sh   # SpacetimeDB CLI (2.10+)
pip install modal && modal token new             # Modal CLI
npm install                                       # Node ≥ 22.4
```

## 1. Database — SpacetimeDB Maincloud

```bash
spacetime login
spacetime publish <your-db-name> --module-path spacetimedb --server maincloud --yes
npm run stdb:generate          # only if you changed the module
```

The database is public to clients by default (all tables are subscribable).
Treat the database name as private and claim the admin role immediately
(step 4).

## 2. Engine identity

The engine needs a stable SpacetimeDB identity (it holds the `engine` role;
Modal containers have no persistent disk):

```bash
MIDAS_STDB_URI=wss://maincloud.spacetimedb.com MIDAS_STDB_DB=<your-db-name> npm run engine:token
# prints identity + MIDAS_STDB_TOKEN=…  (keep it secret)
```

The first engine to connect claims the `engine` role; later identities queue
an operator request that an admin approves in the UI.

## 3. Models and engine — Modal

See `modal/README.md` for every option. In short:

```bash
# GPU models (scale to zero): TimesFM 2.5 + Laya with a Jev-compatible /v1/systemone
modal secret create midas-intel MIDAS_MODAL_TOKEN="$(openssl rand -hex 32)"
modal deploy modal/midas_intel.py        # → https://<workspace>--midas-intel-api.modal.run

# the engine (always-on Node container, control API on :8080).
# AI_GATEWAY_API_KEY alone covers Gemini, Jev, embeddings and alt models;
# or set GEMINI_API_KEY (+ TYPESAFE_API_KEY for Jev) instead.
modal secret create midas-engine \
  MIDAS_STDB_URI=wss://maincloud.spacetimedb.com MIDAS_STDB_DB=<your-db-name> MIDAS_STDB_TOKEN=<from step 2> \
  AI_GATEWAY_API_KEY=<key> \
  MIDAS_MODAL_URL=<intel url> MIDAS_MODAL_TOKEN=<intel token> \
  MIDAS_CONTROL_TOKEN="$(openssl rand -hex 32)" \
  TELEGRAM_BOT_TOKEN=<optional> TELEGRAM_ALLOWED_CHATS=<optional>
modal deploy modal/engine_app.py         # → https://<workspace>--midas-engine-engine-serve.modal.run
```

### Model access: one key through Vercel AI Gateway

With only `AI_GATEWAY_API_KEY` (create it under **AI Gateway → API keys** in
the Vercel dashboard) the engine reaches everything through
`https://ai-gateway.vercel.sh`:

| | via the gateway |
|---|---|
| System 1 | **Jev** as `typesafe-ai/jev` on the TypeSafe-compatible `/typesafe/v1/systemone` |
| Swarm, triage, critic, wiki | `google/gemini-3.8-flash` · `google/gemini-3.5-flash-lite` (exact `thinkingLevel` passed through) |
| Pro supervisor, evolution, coach | `google/gemini-3.1-pro-preview`; the supervisor gets a server-side web search tool (`MIDAS_GATEWAY_SEARCH`, default Perplexity) in place of Google Search grounding |
| Embeddings | `google/gemini-embedding-2` at 768 dimensions |
| Second model family | any gateway id in `MIDAS_ALT_MODELS`, e.g. `anthropic/claude-sonnet-5` |

Spend and traces show up in the Vercel dashboard, and the engine records the
gateway's billed cost per call in `llm_usage`. When `GEMINI_API_KEY` is also
set the engine calls Gemini directly and keeps the gateway for Jev and alt
models; `MIDAS_GEMINI_VIA=gateway` sends Gemini through the gateway anyway.

Scale out ledger workers with the `worker` function described in
`modal/README.md` (`MIDAS_ROLE=worker`); they pull from the same SpacetimeDB
ledger, so no coordination is needed.

## 4. UI — Vercel

Import the repository in Vercel with:

- Root directory: `apps/web` (framework: Next.js; output is a static export)
- Install command: `cd ../.. && npm install`
- Build command: `npm run build`
- Environment:
  - `NEXT_PUBLIC_STDB_URI=wss://maincloud.spacetimedb.com`
  - `NEXT_PUBLIC_STDB_DB=<your-db-name>`
  - `NEXT_PUBLIC_ENGINE_URL=<engine url>` (optional)

Open the site → **Settings → Claim admin** right away. The first claimant
becomes admin; later claims become requests only an admin can approve.

## 5. First session

**New session** → bankroll, risk preset, markets (search Polymarket), thesis
and sources, intelligence budget → **Launch**. The onboarding also offers the
seed folder as a `.zip`; `npm run seed:import -- <folder>` recreates a session
from it.

## 6. Talking to it

- Telegram: `/status`, `/pause 3`, `/kill 3`, `/halt`, `/news <headline>`.
- HTTP (`Authorization: Bearer $MIDAS_CONTROL_TOKEN`):

  ```bash
  curl -H "Authorization: Bearer $T" $ENGINE/api/status
  curl -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
       $ENGINE/api/news -d '{"title":"…","summary":"…","url":"…","source":"desk"}'
  curl -X POST -H "Authorization: Bearer $T" $ENGINE/api/halt -d '{"on":true}'
  ```

- Webhooks out: `DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, `MIDAS_WEBHOOKS`.
- MCP (Claude Code or any MCP client operates MIDAS as tools — status, push
  news, pause/kill sessions, global halt):

  ```bash
  claude mcp add midas -e MIDAS_ENGINE_URL=$ENGINE -e MIDAS_CONTROL_TOKEN=$T \
    -- npm run --silent mcp -w @midas/engine
  ```

## 7. Going live (real money) — deliberately hard

1. Run paper sessions until **Settings → readiness** is green: ≥300 resolved
   forecasts, Brier below the market's, ECE < 0.05, paper PnL 95% interval
   above zero. (The engine enforces this unless
   `MIDAS_LIVE_REQUIRE_READINESS=false`.)
2. Add to the `midas-engine` secret: `MIDAS_LIVE_TRADING=true`,
   `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER`,
   `POLYMARKET_SIGNATURE_TYPE` (3 for deposit wallets created since
   2026-05-04), and caps `MIDAS_LIVE_MAX_ORDER_USD`,
   `MIDAS_LIVE_MAX_BANKROLL_USD`.
3. Switch the session to live in the UI; an admin approves it.
4. Keep the halt switch within reach (UI, Telegram `/halt`, `POST /api/halt`).

Prediction-market trading carries a real risk of loss, and venues restrict
access by jurisdiction — check that you are allowed to trade before enabling
live mode. Use the Manifold adapter (`MANIFOLD_API_KEY`, play money) to
exercise the live order path without real money.

## Local development

```bash
spacetime start                                   # local server on :3000
npm run stdb:publish:local && npm run stdb:generate
cp .env.example .env                              # add GEMINI_API_KEY or AI_GATEWAY_API_KEY
npm run seed:import -- seeds/example-macro-geopolitics
npm run engine                                    # engine + control API on :8080
npm run web                                       # UI on :3001
MIDAS_MODAL_TOKEN=dev python modal/serve_local.py # optional: TimesFM + Laya locally
```

No keys yet? `node apps/engine/scripts/mock-gemini.mjs` serves canned,
schema-shaped answers for both the Gemini API and the AI Gateway endpoints.
Start the engine with `GEMINI_API_KEY=mock MIDAS_GEMINI_BASE_URL=http://127.0.0.1:8799`
(direct) or `AI_GATEWAY_API_KEY=mock MIDAS_GATEWAY_URL=http://127.0.0.1:8799`
(gateway), push a headline through `/api/news`, and watch the whole path
(triage → reflexes → swarm → Pro → decide → paper fill) run;
`curl localhost:8799/__requests` shows what the engine sent. Paper sessions only.

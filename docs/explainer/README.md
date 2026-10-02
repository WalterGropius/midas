# MIDAS explainer (motion graphic)

A 2:15 motion graphic: a hook short enough to share on social, then the
architecture, what makes MIDAS different, the markets it targets, and an
honest $500 × 6-month ROI model.

| File | What it is |
|---|---|
| `midas-explainer.html` | The animation. One self-contained page (fonts and data inlined) drawing every frame on a canvas as a pure function of time. Open it in a browser to play, scrub or jump between chapters. |
| `midas-explainer.mp4` | 1920×1080, 30 fps, H.264, silent. Fits X/Twitter's 2:20 limit. |
| `roi-sim.ts` | The Monte Carlo behind the ROI chapter. Writes its results into the page. |
| `render.mjs` | Renders the page to MP4 frame by frame (no screen recording, so no dropped frames). |

## Storyboard

| Time | Chapter | Point |
|---|---|---|
| 0:00 | Hook | 6 frontier models lost money trading live (Prediction Arena: −16% to −31% on Kalshi). The only rigorously reported winner had the same forecasts and better rules (Raven-Agent: −10.7% naive vs +15.9% with ¼-Kelly, filters and caps). |
| 0:15 | The loop | News → System 1 → swarm → supervisor → rules → order, with learning feeding back. |
| 0:25 | System 1 | Jev/Laya reflexes on every headline × market pair; typed, calibrated questions. |
| 0:35 | System 2 | Blind Flash swarm, pooled in log-odds, Platt-calibrated, blended with the market at w = 0.25; Pro supervisor for contested cases. |
| 0:49 | Decision plane | A reaction trade rejected as already priced; a value trade clearing 10 gates, then ¼-Kelly sizing; the live triple gate. |
| 1:05 | Learning | Graph memory, evolution ratchet, reflex coach, lessons, analog prior — ground truth only. |
| 1:16 | Infrastructure | Vercel + SpacetimeDB + Modal; the engine is killed and resumes from the tables. |
| 1:26 | Why it's different | Six documented failure modes of LLM traders and MIDAS's answer to each. |
| 1:37 | Where it hunts | 15–85¢, 3–90 days out, thinner and second-order markets, neg-risk sets, low fees. |
| 1:48 | $500 × 6 months | Fan chart of three edge scenarios, the LLM bill, the aggressive preset. |
| 2:08 | Outro | Paper by default. Live behind a triple gate. Only ground truth teaches. |

## How honest is the ROI chapter?

MIDAS has no live track record yet (v0.1 is paper-first, and real money is
refused until the readiness gate passes), so the video shows a scenario model,
not results, and says so on screen.

- **What is real code:** `sizePosition` (fractional Kelly walked through the
  book), `maxStakeUsd` (3% per market, 40% gross, cash), `circuitBreaker`
  (−5% day pause, −15% drawdown kill), Polymarket's `p(1−p)` taker fee, the
  value-trade hurdle and the reaction-trade target/stop rules — all from
  `@midas/core` and `apps/engine/src/trade/decide.ts`.
- **What is assumed:** how much of the edge the system claims is real. Value
  trades blend the forecast with the market at `modelTrust` 0.25, so the
  claimed edge is 0.25 × the raw disagreement. If the truly optimal weight is
  w*, the real edge is w*/0.25 of the claim:
  - **bull** w* = 0.20, the research optimum (Halawi et al.: 4:1 crowd:model)
  - **base** w* = 0.10
  - **bear** w* = 0, the forecasts add nothing beyond the price
- **Also assumed:** 2.5 gate-clearing candidates a day (55% of them news
  reactions), spreads of 1–4¢, a 55% fill rate on resting maker orders with 0.75 pt
  of adverse selection, and an LLM budget of $1/day (`MIDAS_LLM_DAILY_BUDGET_USD`).
- **Conservative choices:** value trades are held to a binary payoff, a
  kill-switch trip ends the six months, and markets are treated as
  independent.

Change any of these at the top of `roi-sim.ts` and re-run it; the chart, the
cards and the cost box all read the new numbers.

## Regenerate

```bash
npx tsx docs/explainer/roi-sim.ts            # re-run the Monte Carlo, update the page
npm install --no-save playwright-core        # once; uses an installed Chromium
CHROMIUM_PATH=/path/to/chromium node docs/explainer/render.mjs
node docs/explainer/render.mjs --stills 3,60,120   # PNG stills for a quick look
node docs/explainer/render.mjs --from 0 --to 15 --out hook.mp4   # the hook alone
```

`render.mjs` needs `ffmpeg` on the PATH. Fonts are Inter Tight, JetBrains Mono
and Instrument Serif (SIL Open Font License), embedded as WOFF2.

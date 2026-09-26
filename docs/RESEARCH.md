# Research basis

Every non-obvious choice in MIDAS traces to evidence. Full reports (with
citations, evidence grades and what could not be verified) are in
`docs/research/`:

- [`forecasting-evidence.md`](research/forecasting-evidence.md) — LLM
  forecasting, aggregation, news → market reaction, prediction-market
  efficiency, time-series foundation models, Kelly under uncertainty, LLM
  trading agents (live results).
- [`memory-evolution-harness.md`](research/memory-evolution-harness.md) —
  graph memory (HippoRAG 2, Graphiti/Zep, Mem0, A-MEM, GraphRAG, Letta),
  Karpathy's LLM Wiki and autoresearch, self-evolution (GEPA, AlphaEvolve,
  DGM, ShinkaEvolve, ACE), debate/ensembles, cascades, harness engineering.
- [`api-facts-2026-09.md`](research/api-facts-2026-09.md) — verified API
  details (Gemini, Polymarket CLOB V2, RSS feeds, TimesFM, Modal, Next.js,
  Jev, Laya) as of 2026-09-26.

## The honest headline

- LLMs have roughly reached superforecaster parity on curated questions, but
  **single LLM systems still trail liquid market prices**; combining the model
  with the market helps a little (model weight ≈0.2–0.35).
- **Live, end-to-end LLM trading has mostly lost money** (Prediction Arena:
  all six frontier models −16% to −31% on Kalshi; Alpha Arena: 4 of 6 lost).
  The one rigorous positive result came from a *deterministic* belief-to-trade
  layer: quarter Kelly, edge filters, hard caps.
- **News edges are real but decay** and liquid markets absorb news in seconds
  to minutes; an RSS pipeline should assume it is late.
- **Time-series foundation models are baselines**, not alpha, on returns.
- The best-evidenced prediction-market edge is **consistency/arbitrage**.

MIDAS is therefore built as a disciplined harness first — paper by default,
live only behind a readiness gate — with the intelligence layered on top.

## Findings → decisions → code

| Evidence | Decision | Where |
|---|---|---|
| LLMs that see the crowd do worse than a formula combining blind estimates with the crowd (Schoenegger S2) | forecasters never see the price; combination by formula | `intel/common.ts` `marketBlock`, `prompts.ts` METHOD |
| Market is the prior: 4:1 crowd:model optimal (Halawi); fitted w=0.33 (AIA) | `modelTrust` default 0.25, blend in log-odds | `core/aggregate.ts` `blendWithMarket`, `core/risk.ts` |
| 6–10 samples; log-odds trimmed mean/median; never an LLM aggregator | swarm K=6 default, trimmed log-odds pooling | `core/aggregate.ts`, `intel/swarm.ts` |
| same-model errors correlate ρ≈0.7 | optional second model family via OpenRouter | `llm/openrouter.ts`, `MIDAS_ALT_MODELS` |
| recalibrate before fusing; slope ≈1.5 until data; clip [0.03, 0.97] | Platt calibrator per component; default slope 1.5 | `core/calibration.ts`, `learn/calibrate.ts` |
| Pro ≫ Flash on probability (Brier 0.134 vs 0.179) | Flash for breadth/triage, Pro supervisor for contested cases (AlphaEvolve pattern) | `intel/deliberate.ts` |
| supervisor that resolves disagreements (not a free-form aggregate); no homogeneous debate | Pro sees arguments, not a vote; searches; combined at fixed weight | `intel/deliberate.ts` |
| cascade: escalate on agreement <0.6, logit SD >0.5, edge, <72 h to resolution | escalation rules + `route.escalate` reflex for borderline cases | `intel/swarm.ts` |
| trade only mid-range (0.15–0.85), ≥3 days out; never longshots <10¢ | value-strategy filters | `trade/decide.ts` |
| assume RSS is late; skip if ≥50% of the predicted move happened | reaction-strategy "already priced" gate | `trade/decide.ts` |
| edge > half-spread + fee + 2 pp; ≥70% of ensemble on the side; >1.5σ ensemble | hurdle + agreement gate | `trade/decide.ts` |
| fee = rate × p(1−p), takers only; makers 0 + rebates | per-market `feeRate`; post-only for value trades | `trade/executor.ts` |
| quarter Kelly; shrinking to market ≡ fractional Kelly | Kelly × 0.25 × confirmation confidence on the blended p | `core/kelly.ts`, `trade/decide.ts` |
| hard limits in code: ~2%/market, 10%/cluster, 40% gross, stop at 15% DD | defaults + presets; cluster cap; kill switch | `core/risk.ts`, `trade/portfolio.ts` |
| ≤20% of visible depth | depth cap in sizing | `trade/decide.ts` |
| consistency/arbitrage is the best-evidenced edge | neg-risk sum-to-one scanner | `intel/arb.ts` |
| TimesFM is a baseline; TimesFM-3 weights non-commercial | TimesFM 2.5 on Modal, logit space, random-walk fallback; only a weak confirmation | `modal/`, `intel/forecast.ts` |
| promote to money only after ≥300 resolved, Brier < market, ECE < 0.05, ROI CI > 0 | enforced readiness gate on live orders | `trade/readiness.ts` |
| HippoRAG 2: PPR damping 0.5, ≤5 specific seeds | graph retrieval | `core/graph.ts`, `memory/graph.ts` |
| Graphiti: bi-temporal edges, invalidate don't delete; point-in-time reads | `validFrom/createdAt/invalidatedAt`, `asOfMs` everywhere replays run | `spacetimedb/src/schema.ts`, `core/graph.ts` |
| ACE: playbook bullets with helpful/harmful counts; ground truth only (−3.4 to −3.7 pts without labels) | lessons as nodes, credited by realized outcomes, retracted when harmful ≥ helpful+2 | `learn/score.ts`, `memory/dream.ts` |
| GEPA: reflective mutation from a few cases; Pareto-front parent selection | agent evolution | `learn/evolve.ts`, `core/evolution.ts` |
| staged acceptance with paired bootstrap; sealed held-out split | ratchet: time-split held-out replays, `ratchetAccept` | `core/evolution.ts` |
| Karpathy LLM Wiki: raw/ immutable, wiki/ compiled, index.md, log.md, lint | seed folders + wiki compiler + `wiki.stale` lint reflex | `core/seed.ts`, `memory/wiki.ts` |
| sleep-time compute / autoDream consolidation when idle | `dream` task gated on an idle queue | `memory/dream.ts` |
| backtests leak with date-filtered search (71–81%) | replays use only the system's own timestamped archive + as-of memory | `learn/evolve.ts` |

## From the founder's vault (Laifea)

Principles distilled from the vault notes ("Agentic Graph Engineering (2026
Synthesis)", "Anthropic Graph Engineering Playbook", "The Graph-Grounded
Kernel", "Sombra Asynchronous Swarm Architecture", "AI Agent Learnings: The
Claude Code Leak", "agents that ship", "betting the whole stack on
spacetimedb", "measuring gemini's invisible cache", "Multi-Source Correlation",
"Test-Time Policy Optimization", "Reward Hacking and the Genie Problem"):

- **Everything in SpacetimeDB**; the database is the synaptic ledger; compute
  is a stateless nozzle; rate limits pause cognition instead of losing it.
- **Five planes**; keep work lineage (ledger) separate from domain truth
  (graph); every output traceable.
- **The ratchet** (autoresearch): fixed metric, keep or revert, log every trial.
- **Skeptical memory**: memory is a hint; verify before acting.
- **Harness over model**: the log, not the model, decides progress; break
  repeated-failure loops; bounded budgets.
- **Byte-stable prompt prefixes** make Gemini's implicit cache the unit
  economics; measure the hit rate.
- **Multi-source correlation**: independent confirmations compound
  (1 − Π(1 − cᵢ)) — used as the decision layer's confirmation count.
- **Negative space is informative** (TTPO): reflection targets the confident
  failure, not the whole trajectory.
- **Genie problem**: optimizers game proxies — hence ground-truth-only fitness,
  sealed evaluators, and hard-coded money rules no agent can edit.

## System 1: Jev and Laya

Two "System One" decision models launched in September 2026: **Jev**
(TypeSafe AI; hosted API, typed `noul`/`choice`/`score` questions with
calibrated probabilities, ~70–500 ms, $0.042 per 1M input tokens) and **Laya**
(Convai; open Apache-2.0 ModernBERT decision heads, ~33–40 ms on a T4,
Jev-compatible wire protocol via `laya-serve`). MIDAS treats them as the
fast reflex layer and tunes their *questions* (not weights) from experience;
Laya ships over-confident, so every reflex gets its own Platt calibrator.

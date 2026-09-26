# Evidence base for an LLM + TimesFM + Kelly trading system on Polymarket

*Research date: 2026-09-26. Scope: the scientific and empirical evidence behind a system that (a) ingests RSS news, (b) predicts how markets react to news, (c) forecasts probabilities with an LLM ensemble (Gemini Flash + Pro), (d) uses a time-series foundation model (TimesFM) as a baseline, and (e) sizes bets with Kelly.*

**Evidence grades used below**

- **[A]** Peer-reviewed journal or major conference (ICML/ICLR/NeurIPS/KDD/TMLR/Science Advances, and so on).
- **[B]** arXiv or SSRN preprint with its own data or experiments. It may be very recent and unreplicated.
- **[C]** Industry technical report, benchmark operator blog, vendor blog, or secondary summary.
- **[U]** Unverified. I could not read the primary text, and the claim comes only from a search snippet or abstract.

Many of the most relevant 2026 papers are single-author or small-sample arXiv preprints. Treat their numbers as indicative only.

---

## 0. Executive summary

1. **LLMs have roughly reached superforecaster parity on curated question sets, but not on liquid markets.** On ForecastBench, the best AI systems became statistically indistinguishable from 2024 superforecasters by July 2026 [C]. On liquid prediction markets, single LLM systems still trail the market price. Examples: AIA Forecaster scored Brier 0.126 against the market's 0.111 [B]. Foresight-32B scored 0.199 against Polymarket's 0.170 [C]. In Hindcast and TimeSeek, no LLM beat the market [B].
2. **Combining the LLM with the market helps, but only a little.** The LLM should get roughly 20-35% weight. Halawi et al. found 4:1 crowd:LM optimal, improving Brier from .149 to .146 [A]. AIA's learned weights were 0.33 AIA / 0.67 market, improving Brier from 0.111 to 0.106 [B].
3. **Live, end-to-end LLM trading has mostly lost money.**
   - Prediction Arena on Kalshi: all six frontier models lost 16-31% over 57 days [B].
   - Alpha Arena S1: four of six models lost money, with losses up to -63% [C].
   - Prophet Arena: no model broke even under its betting rule [B].
   - The one positive, rigorously reported result (Raven-Agent, +15.9% ROI on a small sample) came from a **deterministic belief-to-trade layer** built on quarter-Kelly, edge filters and hard risk caps, not from better forecasts [B].
4. **LLM news signals are real but decaying.** In equities, LLM headline scores predicted next-day drift, but strategy Sharpe fell from 6.5 in 2021Q4 to 1.2 in 2024 [B/A-track]. Liquid markets price widely disseminated news within seconds to minutes [A]. An RSS pipeline should assume it is late.
5. **Time-series foundation models do not beat a random walk on returns in any reliable way.** Zero-shot TSFMs give negative out-of-sample R² on daily returns [B], and they mostly lose to Log-HAR on volatility [B]. There is no peer-reviewed evidence on prediction-market price series. TimesFM is a reasonable *baseline and volatility band*, not an alpha source. **TimesFM-3's weights are non-commercial**, so production use needs TimesFM 2.5 (Apache-2.0).
6. **Kelly sizing must be heavily fractional.** Estimation error in p is as large as the edge, so heavy shrinkage is warranted. Shrinking the probability toward the market with weight w is *exactly* equivalent to fractional Kelly with fraction w (derived in §5.3).

---

## 1. LLM judgmental forecasting

### 1.1 Foundational studies (2024)

**Halawi, Zhang, Yueh-Han, Steinhardt (2024), "Approaching Human-Level Forecasting with Language Models"**, arXiv:2402.18563, NeurIPS 2024 [A]. https://arxiv.org/abs/2402.18563

- **Setup.** A retrieval-augmented pipeline: the LM generates search queries against historical news APIs, ranks articles by relevance, and summarizes them. Fine-tuned GPT-4 and base GPT-4 each produce multiple forecasts, which are then aggregated. The test set contains only questions opened after 2023-06-01, after the models' knowledge cutoffs. Questions come from five platforms, Polymarket included.
- **Main result.** The system scored Brier **.179** (accuracy 71.5%). The crowd aggregate scored **.149** (77.0%). A random baseline is .250, and the best zero-shot model (GPT-4-1106) scored .208.
- **Combining with the crowd.** A weighted average with **4x weight on the crowd** (tuned on validation) improved the crowd's Brier from **.149 to .146**. In the settings where the system is strong, an unweighted 50/50 average beat the crowd; for example, .237 versus .240 when the crowd sat between 0.3 and 0.7.
- **Selective forecasting.** The system roughly matched or beat the crowd only under restricted conditions:
  - Crowd probability in [0.3, 0.7]: .238 versus .240 (51% of forecasts).
  - At least 5 relevant articles retrieved: .175 versus .143. The gap narrows but does not close.
  - All conditions combined: .240 versus .247 (22% of forecasts).
- **Ablations (Brier):**

  | Configuration | Brier |
  |---|---|
  | No retrieval, no fine-tuning | .206 |
  | Base GPT-4 with retrieval | .186 |
  | Fine-tuned GPT-4 with retrieval (full system) | .179 |
  | Fine-tuned GPT-3.5 in place of fine-tuned GPT-4 | .182 |

  Retrieval accounts for most of the gain.
- **Retrieval settings.** Among k ∈ {5, 10, 15, 20, 30}, **15 article summaries ordered by relevance** was best (validation Brier .177); 20 was similar.
- **Ensembling (6 base forecasts, validation Brier):**

  | Method | Brier |
  |---|---|
  | No ensemble | .1676 |
  | Mean | .1656 |
  | Median | .1651 |
  | Geometric mean | .1655 |
  | **Trimmed mean (best)** | **.1649** |
  | LLM-as-aggregator (universal self-consistency) | .1691 (worse than no ensemble) |

- **Calibration.** Calibration error was mostly *underconfidence*: events forecast near 0 or 1 happened more or less often than predicted, respectively.

**Schoenegger, Tuminauskaite, Park, Bastos, Tetlock (2024), "Wisdom of the silicon crowd: LLM ensemble prediction capabilities rival human crowd accuracy"**, *Science Advances* 10(45), doi:10.1126/sciadv.adp1528 [A]. arXiv:2402.19379. https://www.science.org/doi/10.1126/sciadv.adp1528

- **Study 1.** The **median** of 12 LLMs scored Brier **0.20** on 31 binary questions. The human crowd (925 forecasters) scored **0.19** and a 50% baseline scores 0.25. The LLM median was not significantly different from the crowd (p = .85).
- **Acquiescence bias.** The mean LLM forecast was **57.35%**, while only **45%** of questions resolved Yes.
- **Study 2.** Showing the models the human median improved GPT-4 from 0.17 to 0.14 and Claude 2 from 0.22 to 0.15. **However, both updated forecasts were worse than a naive human-machine average** (p = .011 and p = .001). Statistical fusion beats letting the LLM "reason about" the crowd number.

**Schoenegger, Park, Karger, Trott, Tetlock (2024), "AI-Augmented Predictions: LLM Assistants Improve Human Forecasting Accuracy"**, arXiv:2402.07862 (later ACM TiiS) [A/B]. https://arxiv.org/abs/2402.07862

- LLM assistants improved human accuracy by **24-28%** (N = 991). Excluding one outlier item, the improvement was 41%.

**Karger, Bastani, Yueh-Han, Jacobs, Halawi, Zhang, Tetlock (2025), "ForecastBench: A Dynamic Benchmark of AI Forecasting Capabilities"**, ICLR 2025, arXiv:2409.19839 [A]. https://arxiv.org/abs/2409.19839

- **Original results (200-question human subset):**

  | Forecaster | Brier |
  |---|---|
  | Superforecaster median | **0.096** |
  | Public median | 0.121 |
  | Best LLM (Claude 3.5 Sonnet, with crowd "freeze values") | 0.122 |
  | Best LLM without crowd values | 0.136 |

- **Crowd values help the standalone LLM.** Giving the model the market or crowd forecast improved it from 0.136 to 0.122.
- **Naive retrieval hurt.** Adding retrieved news to the scratchpad worsened Brier from 0.122 to 0.127.

**Pratt, Blumberg, Carolino, Morris (2024), "Can Language Models Use Forecasting Strategies?"**, arXiv:2406.04446 [B]. https://arxiv.org/abs/2406.04446

- Models tend to guess that most events are unlikely, which inflates scores on base-rate-skewed datasets.

**Paleka et al. (2025), "Consistency Checks for Language Model Forecasters"**, ICLR 2025, arXiv:2412.18544 [A]. https://arxiv.org/abs/2412.18544

- Arbitrage-based consistency metrics, such as P(A) + P(not A) = 1 and conditional coherence, correlate with future Brier. They can therefore serve as a *label-free* monitor.

### 1.2 State of the art 2025-2026: humans versus bots

**ForecastBench trajectory** (Forecasting Research Institute blog posts; methodology note by Kucinskas) [C]:

| Date | Superforecasters | Best AI | Notes |
|---|---|---|---|
| Oct 2025 | 0.081 | ~0.101 (frontier LLMs) | Via the EA Forum synthesis "AI Forecasting in 2026: What 11 analyses say" |
| Jan 29, 2026 | **0.085** | **0.102** (xAI Grok 4.20 preview; Cassi `ensemble_2_crowdadj`) | Difficulty-adjusted Brier |
| Jul 16, 2026 | — | Cassi AI, xAI and Google DeepMind statistically indistinguishable from superforecasters | Cassi ranked above superforecasters on market questions for the first time |

- **Rate of progress.** LLMs improved about **0.015 Brier per year**, and in January FRI projected parity in November 2026 (95% CI January 2026 to November 2027). https://forecastingresearch.substack.com/p/llms-are-closing-the-gap-on-human
- **Crowd adjustment.** Cassi's variant compares its forecast with the market price and re-reviews it when they disagree. This gained **~0.01 Brier**.
- **Parity in July 2026.** https://forecastingresearch.substack.com/p/ai-models-have-likely-reached-parity
- **Caveat.** Superforecaster forecasts were elicited once in 2024, on different questions. Parity is statistical overlap, not clear superiority.

**Metaculus AI Benchmark (bots versus pros)** [C]. https://www.lesswrong.com/posts/Surnjh8A4WjgtQTkZ/q2-ai-benchmark-results-pros-maintain-clear-lead

- **Pros beat the bot team every quarter.** Head-to-head spot peer scores:

  | Quarter | Bot team score |
  |---|---|
  | Q3 2024 | -11.3 |
  | Q4 2024 | -8.9 |
  | Q1 2025 | -17.7 |
  | Q2 2025 | -20.03 (95% CI [-28.6, -11.4], p = 0.00001) |

- **Q2 2025 winning bot.** An agentic workflow with separate outside-view and inside-view reports, finishing with 5 runs across Sonnet 3.7, o4-mini and o3.
- **Practices that correlated with higher scores:** forecast aggregation (+1,799 points), manual review (+1,041), and building custom test questions (+2,216).
- **Model versus scaffolding.** "Model quality has more of an effect on forecasting accuracy than scaffolding." Metaculus's simple in-house bots (one search, a simple prompt, 5 forecasts) placed in the top 6 for four quarters.
- **Later synthesis** (EA Forum, "AI Forecasting in 2026: what 11 analyses say") [C]. https://forum.effectivealtruism.org/posts/Spyz3wESZu2eeqhDj/ai-forecasting-in-2026-what-11-analyses-say
  - 86% of Fall 2025 winners ensembled across model families.
  - Platt/logistic recalibration improved binary Brier by **0.016** (p < 0.001).
  - Winners spent about **$1.40 per question (~28 LLM calls)**, versus $0.50 (7 calls) for non-winners.
  - Capping extreme predictions correlated with winning (r = +0.48).
  - The number of research sources correlated with performance (r = 0.42).
  - Metaculus Cup: bots placed in the top 3-6% of humans. Spring 2026: claude-4.5-sonnet bot ranked 33rd of 1,130.

**AIA Forecaster (Alur, Stadie, Kang, ..., Sekhon; Bridgewater AIA Labs, 2025), "AIA Forecaster: Technical Report"**, arXiv:2511.07678 [B/C]. https://arxiv.org/abs/2511.07678

- **ForecastBench:**

  | Split | AIA Forecaster | Superforecasters |
  |---|---|---|
  | FB-7-21 | 0.1076 | 0.1110 |
  | FB-8-14 | 0.1099 | 0.1152 |
  | FB-Market | 0.0753 | 0.0740 |

- **MarketLiquid (1,610 liquid-market questions, April-May 2025):**

  | Forecaster | Brier |
  |---|---|
  | **Market consensus** | **0.1106** |
  | AIA Forecaster | 0.1258 |
  | o3 | 0.1324 |
  | Simplex-regression ensemble (0.33 AIA / 0.67 market) | **0.106** |

  The ensemble weights had 95% CIs of [0.12, 0.47] for AIA and [0.53, 0.80] for the market. On FB-Market, where "market" means less liquid platforms, AIA took weight 0.87.
- **Base models on MarketLiquid (no supervisor):**

  | Model | Brier |
  |---|---|
  | Claude Sonnet 4 | 0.1195 |
  | o3 | 0.1242 |
  | Qwen-32B | 0.1404 |
  | GPT-5 | 0.1412 |
  | **Gemini 2.5 Pro** | **0.1456** |
  | GPT-4o | 0.1485 |

- **Ensembling.** Brier drops sharply from 1 to 5 independent runs and improves a little more up to 15. The authors adopt **10 runs**. On FB-7-21: mean 0.1140, trimmed mean 0.1142, median 0.1138, single run 0.1182. The aggregator choice matters far less than *having* an ensemble.
- **Supervisor agent.** An agent that reconciles disagreeing runs scored 0.1125, versus 0.1168 for a non-agentic supervisor and 0.1199 with no synthesis.
- **Search.** On 64 live markets, agentic search gave Brier 0.1002 versus 0.3609 without it. On a static set the gain was about 7%.
- **Calibration.**
  - LLMs "hedge too much" and systematically output values such as 0.95 instead of 1.0.
  - Platt scaling with coefficient **α = √3 ≈ 1.73**, from Neyman & Roughgarden, is mathematically equivalent to log-odds extremization and strictly improved Brier. The benchmark-optimal α was 2.27, which they did not use, to avoid overfitting.
  - The largest gains came for raw forecasts in **[0.2, 0.4) ∪ [0.6, 0.8)**.

**Mantic plus Thinking Machines Lab (Jeen, Aitchison and Mantic, 2026-03-19), "Training LLMs to Predict World Events"** [C]. https://thinkingmachines.ai/news/training-llms-to-predict-world-events/

- **RL fine-tuning.** RL on about 10k binary questions (August 2024 to December 2025) raised gpt-oss-120b from 38.6 to 45.8 on a baseline score, marginally above Gemini 3 Pro.
- **Reward choice.** A Brier-score reward gave more stable training than log score.
- **Ensemble.** The optimal 5-slot ensemble was fine-tuned gpt-oss-120b (40%) plus Gemini 3 Pro, GPT-5 and Grok 4 (20% each). Grok 4 was the least replaceable member, meaning diversity of model family matters.
- **Tournament.** Mantic beat the community prediction and most pros in the Fall 2025 Metaculus Cup.

**FutureSearch** [B/C]

- Wildman et al. (2025), "Bench to the Future: A Pastcasting Benchmark for Forecasting Agents", arXiv:2506.21558 [B]. https://arxiv.org/abs/2506.21558 It pairs hundreds of resolved questions with an offline corpus of tens of thousands of pages, giving hermetic, repeatable evaluation.
- Bosse et al. (2026), arXiv:2601.22444 [B]. On 1,499 automatically generated questions: **Gemini 3 Pro 0.134, GPT-5 0.149, Gemini 2.5 Flash 0.179**. On the same questions, the Pro-tier model is about 0.045 Brier better than Flash. https://arxiv.org/abs/2601.22444
- Their BTF-3 leaderboard (June-August 2026) shows the top system at about 0.116 and lists no Gemini models. Model names were read off the page and not independently verified [C]. https://evals.futuresearch.ai/

**Other benchmarks and methods**

- **FutureX** (arXiv:2508.11987) [B]. A live benchmark built from 195 websites, evaluating 25 LLMs and agents. It documents agent vulnerability to fake web pages and temporal-validity errors. https://arxiv.org/abs/2508.11987
- **PROPHET** (arXiv:2504.01509) [B]. 612 "inferable" questions filtered by Causal Intervened Likelihood, with paired news for RAG. https://arxiv.org/abs/2504.01509
- **Prompt engineering.** Schoenegger et al. (2025), arXiv:2506.01578 [B], tested 38 prompts. Most gave **negligible** gains; mentioning base rates helped slightly. "Bayesian reasoning" and propose-evaluate-select prompts significantly *hurt* accuracy. https://arxiv.org/abs/2506.01578
- **Deliberation.** Schneider & Schramm (2025), arXiv:2512.22625 [B], used 202 Metaculus Q2 2025 questions. Deliberation among *diverse* models (GPT-5, Claude Sonnet 4.5, Gemini 2.5 Pro) cut log loss by **0.020 (~4%, p = 0.017)**. Homogeneous groups gained nothing. https://arxiv.org/abs/2512.22625
- **Ensemble composition.** Chetlapalli et al. (2026), arXiv:2608.24001 [B]. A 3-model crowd picked by behavioral clustering beat voting over all 25 models while using 88% fewer calls, so composition matters more than size. https://arxiv.org/abs/2608.24001
- **Correlated errors.** Begin et al. (2026), arXiv:2606.26583 [B]. Preference-optimized LLM agents share errors: pairwise error correlation **ρ ≈ 0.70**, so **10 agents behave like about 1.4 independent forecasters**. Cross-model diversity lowered ρ from 0.68 to 0.40. https://arxiv.org/abs/2606.26583
- **Learned aggregation and contamination.** Douven (2026), arXiv:2607.18269 [B], used 15 LLMs on 254 questions. Learned aggregators (logistic regression was as good as an MLP) beat mean and median. On questions resolving after *all* training cutoffs, the frontier-versus-small-model gap shrank from 35.8% to 8.9%, so contamination inflates frontier scores. https://arxiv.org/abs/2607.18269
- **Directional bias.** Cho & Koshiyama (2026), "OptimismBench", arXiv:2607.26981 [B]. **14 of 16** models are optimistically biased, and post-training sets the sign of the bias, which differs by provider family. Calibration therefore has to be fitted per model. https://arxiv.org/abs/2607.26981
- **Human experts still lead.** Lu (2025), arXiv:2507.04562 [B], used 464 Metaculus questions. Frontier LLMs beat the general crowd but "significantly underperform" expert forecasters. https://arxiv.org/abs/2507.04562

### 1.3 Training LLMs specifically for forecasting on Polymarket data

**Turtel, Franklin, Schoenegger (2025), "LLMs Can Teach Themselves to Better Predict the Future"**, arXiv:2502.05253 [B]. https://arxiv.org/abs/2502.05253

- Self-play plus DPO, ranking reasoning traces by distance to the outcome, improved Phi-4 14B and DeepSeek-R1-14B accuracy by **7-10%**, reaching parity with GPT-4o.

**Turtel, Franklin, Skotheim, Hewitt, Schoenegger (2025), "Outcome-based Reinforcement Learning to Predict the Future"**, TMLR (Nov 2025), arXiv:2505.17989 [A]. https://arxiv.org/abs/2505.17989

- **Data.** 12,100 Polymarket binary questions: 9,800 for training (resolved July-December 2024) and 2,300 for testing (December 2024 to January 2025).
- **Method.** Modified GRPO without per-question variance normalization, and ReMax, so gradients stay proportional to Brier loss.
- **Result.** A 14B model matched o1-level accuracy while **halving ECE**. A **seven-run ensemble** reached Brier **0.190** [0.178, 0.203] with ECE 0.062 on a 1,265-question hold-out. A simulated Polymarket strategy returned **ROI > 10%**. This is a simulation, and the backtest ran against the price at forecast time.

**Lightning Rod Labs, "Foresight-32B beats frontier LLMs on live Polymarket predictions"** (blog, 2025-08-27) [C]. https://blog.lightningrod.ai/p/foresight-32b-beats-frontier-llms-on-live-polymarket-predictions

- **Sample.** 251 live questions with volume ≥ $1k, prices 0.05-0.95, resolving within one month.
- **Result.** Foresight-32B scored Brier **0.199** (ECE 6.0%); **the market scored 0.170**. "No AI model beats the market." Foresight-32B and o3 were "profitable" under the blog's strategy; Gemini 2.5 Pro was not.

### 1.4 LLM forecasters measured against real prediction markets

**Yang, Mahns, Li, Gu, Wu, Xu (2025), "LLM-as-a-Prophet: Understanding Predictive Intelligence with Prophet Arena"**, arXiv:2510.17638 [B]. https://arxiv.org/abs/2510.17638

- **Sample.** 1,367 Kalshi events (72,136 markets, cutoff 2025-10-11); 76% sports.

| Forecaster | Brier | Average return (≥ 1 means break-even) | ECE |
|---|---|---|---|
| GPT-5 (reasoning) | **0.184** | 0.943 | 0.042 |
| Grok-4 | 0.189 | 0.864 | 0.043 |
| Claude Sonnet 4 | 0.194 | 0.909 | 0.041 |
| Gemini 2.5 Flash | 0.197 | 0.883 | 0.067 |
| **Kalshi market** | **0.187** | 0.899 | 0.069 |

- **Brier parity does not mean profit.** The best model slightly beat the market on Brier yet **still lost money**; "even GPT-5R fails to reach break-even" under the paper's utility-maximizing betting rule.
- **LLMs are more conservative than markets.** Models underweight outcomes the market treats as near-certain.
- **Markets win near resolution.** Close to resolution, "markets incorporate breaking information... more rapidly than LLMs." Forecasts made within 3 hours of resolution were excluded.

**Other head-to-head comparisons**

- **TimeSeek.** Mostafa, Shastri, Lee (2026), arXiv:2604.04220 [B]. https://arxiv.org/abs/2604.04220
  - 10 models on 150 Kalshi markets at 5 lifecycle checkpoints (15k forecasts).
  - Models are **best early in a market's life and on high-uncertainty markets**, and worst near resolution and on strong-consensus markets.
  - Search helped in pooled Brier skill but **hurt in 12% of model-checkpoint pairs**.
  - Two-model ensembles "did not surpass the market overall."
- **Hindcast.** Ye et al. (2026), arXiv:2607.14051 [B]. https://arxiv.org/abs/2607.14051
  - 216 Polymarket markets replayed against frozen pre-t₀ Reddit snapshots.
  - Retrieval improved 8 of 9 open models; Qwen3-32B went from 0.234 to 0.179.
  - Retrieval **backfired where the corpus held only speculation**: -31 net regressions in Entertainment.
  - No LLM systematically beat the market.
- **Can LLM forecasters profit?** "Beyond Accuracy: Can LLM Forecasters Profit on Prediction Markets?" (OpenReview, 2026) [U]. https://openreview.net/forum?id=TSA5kRUKZv
  - I saw only the abstract snippet; the full text sits behind a bot check.
  - The best LLM had accuracy "statistically indistinguishable from the market" but higher realized returns, with the edge "entirely from losing less when wrong," exploiting behavioral biases.
  - Within-crowd agreement across a diverse set of LLMs, used as a confidence filter, strengthened returns.
- **Uneven by domain.** Karkar & Chopra (2025), "Future Is Unevenly Distributed", arXiv:2511.18394 [B]. https://arxiv.org/abs/2511.18394
  - 150 questions. Adding news *helped* finance and sports but *hurt* entertainment (accuracy fell from 68% to 40-56%) and technology.
  - Failure modes: recency bias, rumour overweighting, and definition drift from ambiguous acronyms.

### 1.5 What demonstrably improves Brier (effect sizes)

| Intervention | Effect | Source |
|---|---|---|
| Retrieval of news (good corpus) | .206 → .186 Brier (Halawi); 0.234 → 0.179 (Hindcast, Qwen3-32B); 0.361 → 0.100 on live markets (AIA) | [A], [B], [B] |
| Retrieval (naive or noisy) | ForecastBench: 0.122 → 0.127 (worse). Hurts in rumour-heavy domains | [A], [B] |
| Ensembling 5-10 samples | 0.1182 → 0.1138 (AIA); 0.1676 → 0.1649 (Halawi); aggregation was worth +1,799 points in Metaculus Q2 | [B], [A], [C] |
| Aggregator choice (mean vs median vs trimmed) | ≤ 0.001 Brier difference; LLM-as-aggregator *worse* | [A], [B] |
| Cross-family diversity | Correlation 0.68 → 0.40; diverse deliberation −4% log loss; same-model deliberation 0 | [B] |
| Platt scaling / extremization | −0.016 Brier (Metaculus bots); strict improvement at α = √3 (AIA) | [C], [B] |
| Fine-tuning or RL on resolved questions | .186 → .179 (Halawi); ECE halved (Turtel); +7.2 pts (Mantic) | [A], [A], [C] |
| Giving the LLM the market price | 0.136 → 0.122 (ForecastBench); crowd-adjust −0.01 (Cassi) | [A], [C] |
| Statistical fusion with market | .149 → .146 (Halawi, 80% crowd); 0.111 → 0.106 (AIA, 67% market) | [A], [B] |
| Elaborate prompting (Bayesian, propose-evaluate-select) | Significantly *worse* | [B] |
| Model upgrade | ~0.015 Brier/year; Gemini 3 Pro vs 2.5 Flash: 0.134 vs 0.179 | [C], [B] |

### 1.6 Pitfalls specific to LLM forecasting evaluation

**Paleka, Goel, Geiping, Tramèr (2025), "Pitfalls in Evaluating Language Model Forecasters"**, arXiv:2506.00723 [B]. https://arxiv.org/abs/2506.00723

- It catalogues many forms of **temporal leakage** and the gap between benchmark scores and real-world use.

**El Lahib et al. (2026), "Temporal Leakage in Search-Engine Date-Filtered Web Retrieval"**, arXiv:2602.00758 [B]. https://arxiv.org/abs/2602.00758

- Date-filtered search is not safe for backtests.
  - Google returned major post-cutoff leakage for **≥ 71%** of questions; DuckDuckGo for **81%**.
  - The answer was revealed directly in 41% (Google) and 55% (DuckDuckGo) of cases.
- **Brier with leaked documents was 0.10, versus 0.24 when leak-free.**

**Contamination.** Douven (2026) showed that frontier-model advantages shrink on post-cutoff questions (35.8% to 8.9%). Every backtest therefore needs to be post-cutoff.

---

## 2. Aggregating probability forecasts

| Finding | Numbers | Source |
|---|---|---|
| Linear pooling of distinct calibrated forecasts is necessarily *uncalibrated* (underconfident) and needs recalibration, for example a beta-transformed linear pool | Theorem | Ranjan & Gneiting (2010), JRSS-B 72(1):71-91 [A] https://academic.oup.com/jrsssb/article/72/1/71/7076442 |
| Log-odds (logit) aggregator with one extremizing parameter beats common aggregators on GJP data (1,300+ forecasters, 69 events) | Optimal extremizing factor **d ∈ [1.161, 3.921]** depending on setting | Satopää, Baron, Foster, Mellers, Tetlock, Ungar (2014), IJF 30(2):344-356 [A] https://doi.org/10.1016/j.ijforecast.2013.09.009 (range reported by Powell et al. 2024) |
| Extremizing transformation t(p) = pᵃ / (pᵃ + (1−p)ᵃ) | Year-1 GJP, experts: mean aggregate a = **2.43** (Brier 0.148 vs 0.187 unextremized); median aggregate a = **1.78** (0.160 vs 0.176). Non-experts: mean a = 3.08, median a = 2.34. Two reasons given: shared information across forecasters, and noise that regresses aggregates toward 0.5 | Baron, Mellers, Tetlock, Stone, Ungar (2014), *Decision Analysis* 11(2):133-145 [A] https://pubsonline.informs.org/doi/10.1287/deca.2014.0293 |
| Extremized mean with b ≈ 3 on GJP data | Brier: mean 0.098 → extremized mean 0.061 → skew-adjusted extremized mean 0.046. Symmetric trimmed mean with κ = 0.4 was near-optimal among trims | Powell, Satopää, MacKay, Tetlock (2024), *Decision*, doi:10.1037/dec0000191 [A] https://eprints.whiterose.ac.uk/id/eprint/188361/ |
| Robust (worst-case) aggregation under "projective substitutes": average log-odds extremized by about **√3 ≈ 1.73** | Theory | Neyman & Roughgarden (2022), ACM EC '22, arXiv:2111.03153 [A] https://dl.acm.org/doi/abs/10.1145/3490486.3538243 |
| Geometric mean of odds (log-odds mean) versus arithmetic mean on Metaculus | Extremized log-odds mean best on *log loss*; Brier essentially identical. The optimal extremizing factor is *lower* for log-odds averaging, which is already more extreme | Sevilla (2021), EA Forum (blog) [C] https://forum.effectivealtruism.org/posts/sMjcjnnpoAQCcedL2 |
| Market prices themselves benefit from a debiasing transform, especially for the favourite-longshot bias | Debiased markets beat debiased polls in uncertain races | Rothschild (2009), *Public Opinion Quarterly* 73(5):895-916 [A] https://academic.oup.com/poq/article/73/5/895/1868587 |
| For LLM ensembles, trimmed mean ≈ median ≈ mean >> single sample; LLM-as-aggregator worse | See §1.5 | Halawi [A], AIA [B] |
| Learned stacking (logistic regression on member outputs) beats fixed pools, given enough resolved data | See §1.2 | Douven (2026) [B] |

**Why human-crowd extremizing factors do not transfer directly to LLM ensembles.**

- Extremizing theory, from Satopää and from Baron, justifies pushing the aggregate outward because *independent* information is under-weighted by averaging.
- LLM samples from the same model share nearly all their information, with error correlation around 0.7 (Begin et al. 2026). The information-diversity rationale is weak.
- Recalibration is still justified, because RLHF-trained LLMs systematically hedge (AIA; Halawi) or are directionally biased (Schoenegger; OptimismBench).
- **Practical synthesis:**
  - Fit a Platt or logit-slope recalibration on your *own* resolved forecasts.
  - Before you have data, use a slope of about 1.3-1.7 in log-odds (AIA used √3).
  - Do *not* use GJP values of 2.5-3 for an LLM-only ensemble.
  - Extremize *before* fusing with the market price, not after. The market already contains the diverse information.

---

## 3. From news to market reaction

### 3.1 LLM headline signals in equities

**Lopez-Lira & Tang (2023-2025), "Can ChatGPT Forecast Stock Price Movements? Return Predictability and Large Language Models"**, arXiv:2304.07619 (v6, October 2025) [B, journal track]. https://arxiv.org/abs/2304.07619

- **Sample.** October 2021 to May 2024: 159,137 firm-headline observations across 4,123 firms, using only post-knowledge-cutoff headlines.
- **Initial reaction (not tradable).** GPT-4 predicts the direction of the *initial* reaction with a **93.3%** hit rate for overnight news and 88.8% for intraday news, at the portfolio-day level.
- **Tradable drift.** A long-short drift strategy earned **0.34% per day, Sharpe 2.97 before costs** (GPT-3.5: Sharpe 1.66; DistilBART: 1.26).
- **Costs.** The strategy survives 10 bps round-trip costs but is **unprofitable at 20 bps**.
- **Where the drift is.** It is concentrated in **negative news** (short leg Sharpe 2.01 versus long leg 0.78) and in **small stocks**.
- **Decay.** Sharpe fell from **6.54 in 2021Q4 to 3.68 in 2022, 2.33 in 2023, and 1.22 in January-May 2024**, an ~81% decline "consistent with improved price efficiency" as LLM adoption rose.

**Glasserman & Lin (2023/2024), "Assessing Look-Ahead Bias in Stock Return Predictions Generated by GPT Sentiment Analysis"**, arXiv:2309.17322; *J. Financial Data Science* 6(1) [A]. https://arxiv.org/abs/2309.17322

- **Anonymized headlines outperformed** original headlines in-sample. The "distraction effect", where the model's knowledge of the named company contaminates its sentiment reading, mattered more than look-ahead bias, especially for large firms.
- **Recommendation:** anonymize entities for backtests and robustness checks.

### 3.2 How fast markets incorporate news

- **Stocks: seconds to minutes.** Busse & Green (2002), "Market efficiency in real time", *JFE* 65(3):415-437 [A]. https://econpapers.repec.org/RePEc:eee:jfinec:v:65:y:2002:i:3:p:415-437
  - Prices respond to CNBC analyst reports **within seconds**. Positive reports are fully incorporated **within 1 minute**; negative ones over about 15 minutes.
  - Only traders who act within about **15 seconds** make small profits.
- **Betting exchanges: swift and complete.** Croxson & Reade (2014), "Information and Efficiency: Goal Arrival in Soccer Betting", *Economic Journal* 124(575):62-91 [A]. https://onlinelibrary.wiley.com/doi/abs/10.1111/ecoj.12033
  - Betfair prices update "swiftly and fully" to goals, with no exploitable drift across the half-time break.
- **Prediction markets as high-frequency expectation measures.** Snowberg, Wolfers, Zitzewitz (2007), *QJE* 122(2):807-829 [A]. https://academic.oup.com/qje/article-abstract/122/2/807/1942142
  - Intraday prediction-market prices on election night track news closely enough to identify market reactions (a Republican win moved equities +2-3%).
- **Markets beat LLMs near resolution.** Prophet Arena [B] found markets incorporate breaking news faster than LLMs close to resolution.
- **Markets lead media coverage.** Ibrahim & Zaki (2026), "Price Dislocations, News Citations, and Epistemic Leverage on Polymarket", arXiv:2609.06005 [B]. https://arxiv.org/abs/2609.06005
  - Data: 173.7M trades and 44,976 dislocations (moves ≥ 5 pp backed by one-sided flow).
  - **74% of first news citations come *after* the dislocation, and 58% more than a day later.**
  - The median cost to move a market 5 pp ranged from **$5.2k (least prominent) to $56.9k (most prominent)**.
  - Implication: price moves often *precede* mainstream coverage, and RSS headlines frequently arrive after the market has moved.
- **RSS latency.** I found **no peer-reviewed study** quantifying RSS versus newswire latency. GDELT, for example, processes within about 15 minutes. This is a gap; measure it yourself.

### 3.3 Efficiency, biases and frictions in prediction markets

**Calibration and the favourite-longshot bias (FLB)**

- **Long horizons.** Page & Clemen (2013), *Economic Journal* 123(568):491-513 [A]. https://academic.oup.com/ej/article-abstract/123/568/491/5079498
  - Markets are well calibrated near expiry but **biased for events far in the future**, in the favourite-longshot direction.
- **Kalshi.** Bürgi, Deng, Whelan (2025/2026), "Makers and Takers: The Economics of the Kalshi Prediction Market", UCD WP2025_19 / CEPR DP20631 [B]. https://www.karlwhelan.com/Papers/Kalshi.pdf
  - Over 300k prices. Accuracy improves toward close.
  - Contracts under 10¢ lose **more than 60%**; contracts above 50¢ earn small positive returns.
  - **Average post-fee return: Makers -9.64%, Takers -31.46%.** These are contract-weighted and dominated by longshots.
- **Polymarket.** Cardozo & Rivero-Wildemauwe (2026), "The Favorite-Longshot Bias in Prediction Markets: Evidence from Polymarket", arXiv:2609.12878 [B]. https://arxiv.org/abs/2609.12878
  - 588M trades, 2.48M wallets.
  - Longshots (< 10¢) returned **-6.30%** equal-weighted and -19.35% dollar-weighted, with a wide CI. Favourites (≥ 90¢) returned **+0.28% to +0.83%**.
  - The pattern is **category dependent**: two-sided in crypto and politics, *reversed* in sports.
  - Their conclusion: the favourite premium is **too small to beat costs**.
- **Calibration by domain.** Le (2026), "Decomposing Crowd Wisdom: Domain-Specific Calibration Dynamics in Prediction Markets", arXiv:2602.19520 [B]. https://arxiv.org/abs/2602.19520
  - 353M trades on 429k contracts across Kalshi and Polymarket.
  - Political markets show **persistent underconfidence** (prices cluster toward 50%).
  - Snippet-level summaries put overall calibration slopes at about **1.01-1.13** across horizons, and Polymarket-wide calibration error at about 2 pp. These come from search summaries [U]; treat the exact numbers as unverified.

**Market inefficiency and arbitrage**

- **2024 election.** Clinton & Huang (2025), "Prediction Markets? The Accuracy and Efficiency of $2.4 Billion in the 2024 Presidential Election", SocArXiv [B]. https://ideas.repec.org/p/osf/socarx/d5yx2_v1.html
  - Across more than 2,500 markets in the final five weeks, the share of markets that beat chance was 93% on PredictIt, **78% on Kalshi and 67% on Polymarket**.
  - Identical contracts diverged across venues, and daily changes were weakly or negatively autocorrelated.
  - On 62 of 65 days, Harris + Trump did not sum to $1 on at least one platform.
- **Cross-venue law-of-one-price violations.** Gebele & Matthes (2026), arXiv:2601.01706 [B]. https://arxiv.org/abs/2601.01706
  - Polymarket-Kalshi execution-adjusted gaps averaged **~3¢, up to 7¢**, and persisted. The barriers are semantic non-fungibility and capital lock-up.
- **Within-Polymarket arbitrage.** Saguillo, Ghafouri, Kiffer, Suarez-Tangil (2025), "Unravelling the Probabilistic Forest: Arbitrage in Prediction Markets", AFT 2025 (LIPIcs), arXiv:2508.03474 [A]. https://arxiv.org/abs/2508.03474
  - About **$40M realized arbitrage profit** from April 2024 to April 2025, via "market rebalancing" (outcomes not summing to 1) and "combinatorial" arbitrage across dependent markets.

**Microstructure, fees and other effects**

- **Polymarket order book.** Dubach (2026), "The Anatomy of a Decentralized Prediction Market", arXiv:2604.24366 [B]. https://arxiv.org/abs/2604.24366
  - Median quoted spread is about 400 bps in the [0.4, 0.6] price range and **1,300-1,800 bps for low-probability outcomes**.
  - About 32 effective makers per market; median wash share around 1%.
  - Trade direction from the public feed matches on-chain truth only **about 59%** of the time, so use on-chain OrderFilled events.
- **Spreads in practice.** Prediction Arena [B] reports typical spreads of **2-5¢** and frequent liquidity rejections.
- **Fees.** Polymarket documentation (accessed 2026-09) [C]. https://docs.polymarket.com/trading/fees
  - **Taker fee = shares × feeRate × p × (1 − p).**
  - feeRate: crypto 0.07; sports, economics, culture, weather and other 0.05; politics, finance, tech and mentions 0.04; **geopolitics 0**.
  - Makers pay nothing and receive rebates (15-25%).
  - At p = 0.5 in politics this is 1¢ per share, which is **2% of notional**.
- **Mean reversion.** Quantpedia (2026), own research [C]. https://quantpedia.com/exploiting-mean-reversion-in-decentralized-prediction-markets-evidence-from-polymarket-binary-contracts/
  - On three long-dated Polymarket contracts, a slow mean-reversion strategy survived 10 bps friction and high-turnover variants did not. The sample is tiny; treat as anecdotal.

### 3.4 What this means for "predicting market reaction to news"

**Where the evidence converges**

- Liquid markets absorb widely disseminated news in **seconds to minutes**.
- Prediction-market moves often **lead** media coverage.
- LLM-news alpha in equities **decayed about 80% in 2.5 years**.

**Where edge plausibly remains**

- **Drift or underreaction** in thinner, less prominent markets. This is analogous to small-cap and negative-news drift in Lopez-Lira & Tang.
- **Related markets** that the news affects but does not name. These are second-order and combinatorial effects, in line with the arbitrage and consistency literature.
- **Early-lifecycle, mid-probability markets**, where LLMs are relatively strongest (Halawi, TimeSeek).

**Evidence gap.** I found no rigorous public study of LLM-predicted *direction and size* of Polymarket price reactions to specific news items with proper latency controls.

- PolyBench (Cheng, Liu, Long 2026, arXiv:2604.14199) [B] ran 7 LLMs over one week. Only 2 had positive returns. Models were rigidly confident (0.8-0.9), and alpha collapsed with slippage at $1k size. https://arxiv.org/abs/2604.14199
- PolySwarm (arXiv:2604.03888) [B] is an *architecture proposal with no reported results*. It uses 0.70 swarm + 0.30 market blending, quarter-Kelly, a 5% expected-value threshold and a 5-second scan loop. https://arxiv.org/abs/2604.03888

---

## 4. Time-series foundation models on financial and probability data

### 4.1 TimesFM versions

- **TimesFM 1.0.** Das, Kong, Sen, Zhou (2024), "A decoder-only foundation model for time-series forecasting", **ICML 2024**, arXiv:2310.10688 [A]. https://arxiv.org/abs/2310.10688
  - 200M parameters, pretrained on about 100B time points (Google Trends, Wikipedia pageviews, synthetic ARMA and STL data).
  - Zero-shot accuracy close to supervised state of the art on public benchmarks.
- **TimesFM 2.5** (September 2025) [C]. https://github.com/google-research/timesfm
  - **200M parameters (down from 500M in 2.0), 16k context, optional 30M quantile head for horizons up to 1k.**
  - Ranked **#1 zero-shot on GIFT-Eval (MASE and CRPS) at release**.
  - **Covariates via XReg** (restored 2025-10-29): TimesFM's in-context residuals are regressed linearly on the supplied covariates, and the fitted component is added back. This is not native covariate conditioning.
  - **Code and weights are Apache-2.0.**
- **TimesFM-3** (released **2026-08-31**) [C]. https://research.google/blog/timesfm-3-a-zero-shot-foundation-model-for-multivariate-forecasting/
  - 330M parameters, more than 1T training points.
  - **Native multivariate forecasting with past-only and past-and-future covariates.** Non-autoregressive single-pass decoding with quantiles.
  - Google reports #1 among pretrained models on GIFT-Eval, fev-bench and TIME, with **no finance-specific evaluation**.
  - **Licensing: the weights use `timesfm-non-commercial-license-v1.0`, and commercial or production deployment is not permitted** (GitHub README). A trading system should use 2.5.

### 4.2 General benchmarks

- **GIFT-Eval.** Aksu et al. (2024), arXiv:2410.10393 [B]. https://arxiv.org/abs/2410.10393
  - 23 datasets, 144k series, 7 domains, plus a non-leaking pretraining set of about 230B points. The leaderboard now spans 97 test configurations.
- **Chronos-2.** arXiv:2510.15821 [B]. Surpasses TimesFM-2.5 and TiRex on win rate and skill score. https://arxiv.org/abs/2510.15821
- **TiRex.** xLSTM, 35M parameters, arXiv:2505.23719 [B]. At release it was state of the art on GIFT-Eval and Chronos-ZS. https://arxiv.org/abs/2505.23719
- **Toto** (Datadog, 151M, arXiv:2505.14766) and **Toto 2.0** (arXiv:2605.20119) [B]. Toto 2.0 reports its fine-tuned-and-frozen ensemble first on every GIFT-Eval metric. https://arxiv.org/abs/2605.20119
- **Moirai 2.0.** arXiv:2511.11698 [B].
- **Reading the leaderboard.** It moves every few months and no single TSFM dominates. GIFT-Eval contains little financial return data.

### 4.3 Finance-specific evidence: honest answer is "no reliable edge over a random walk"

- **Daily excess returns.** Rahimikia, Ni, Wang (2025), "Re(Visiting) Time Series Foundation Models in Finance", arXiv:2511.18578 / SSRN 5770562 [B]. https://arxiv.org/abs/2511.18578
  - Off-the-shelf TSFMs perform poorly zero-shot and fine-tuned, losing to CatBoost and LightGBM.
  - Chronos-large (512 lags): **out-of-sample R² = -1.37%**, directional accuracy just over 51%.
  - **TimesFM-500M: R² = -2.80%, directional accuracy just under 50%.**
  - Models *pretrained from scratch on financial data* gave substantial gains.
- **Equity returns versus random walk.** Noguer i Alonso & Franklin (2026), arXiv:2606.27100 [B]. https://arxiv.org/abs/2606.27100
  - TimesFM-2.5, Moirai-2.0, Chronos, Chronos-2 and TimeGPT on 5 US equities.
  - TSFMs won 8 of 10 *rankings*, but "**gains over the random-walk benchmark are small and sparse**". Diebold-Mariano rejected the random walk in only 2 of the model-asset cases.
  - Conclusion: "useful practical priors... not universal engines for statistically reliable alpha."
- **Realized volatility.** Brini (2026), arXiv:2607.05291 [B]. https://arxiv.org/abs/2607.05291
  - 9 TSFMs versus Log-HAR on 50 assets. QLIKE loss ratios versus Log-HAR (values above 1 lose):

    | Model | Daily (h = 1) | Weekly (h = 5) | Monthly (h = 22) |
    |---|---|---|---|
    | **TimesFM 2.5** | 1.086 | 1.201 | 1.331 |
    | Toto | 1.214 | 1.273 | 1.157 |
    | Sundial | 0.998 | 1.084 | 1.182 |
    | TTM (< 1M parameters) | 0.982 | 0.986 | 0.987 |

  - Chronos-Bolt and Moirai 2.0 also exceed 1 at all horizons. **Only TTM beat Log-HAR at every horizon**, by about 1-2%. Log-HAR entered the model confidence set for 86-90% of assets.
- **Value-at-Risk.** Goel, Pasricha, Kanniainen (2024/2025), arXiv:2410.11773 [B]. https://arxiv.org/abs/2410.11773
  - On S&P 100 VaR, **fine-tuned** TimesFM was best or near-best, comparable to GAS. **Zero-shot was suboptimal.**

### 4.4 Applicability to Polymarket price series

- **No peer-reviewed evidence found** on TSFMs forecasting prediction-market price paths.
- **Theoretical prior.** Under risk neutrality with no lock-up costs, a binary contract's price is a martingale converging to 0 or 1. The best point forecast of a future price is the current price (a random walk), and the terminal distribution is two-point. These properties violate the smooth-series assumptions TSFMs are trained on.
- **Honest role for TimesFM here:**
  1. A *no-skill baseline to beat*: always report the random-walk ("no change") forecast alongside it.
  2. A *volatility or quantile band* in logit space, to judge whether a news-driven move is abnormal.
  3. At most a weak feature in a stacked model, and only if it beats the random walk out of sample.

---

## 5. Kelly sizing under estimation uncertainty

### 5.1 Kelly for a binary contract

This section is my own derivation from Kelly (1956) and standard results.

- **Setup.** Buy YES at price q when your probability is p. Each dollar staked returns 1/q if YES.
- **Growth rate.** G(f) = p·ln(1 + f(1−q)/q) + (1−p)·ln(1−f).
- **Optimal fraction.** **f\* = (p − q)/(1 − q)** for YES. For NO (bought at 1 − q): **f\* = (q − p)/q**.
- **Optimal growth.** G(f\*) = KL(p‖q) ≈ (p − q)² / (2q(1 − q)). Growth is *quadratic* in the edge, so small edges yield very little.
- **Fees and spread.** Replace q with the effective execution price q_eff = ask + fee per share, where fee = feeRate·q(1 − q) on Polymarket.
- **Fractional Kelly.** Betting a fraction c of f\* gives growth ≈ G\*·(2c − c²):
  - Half-Kelly keeps about **75% of the growth** at about half the volatility.
  - **2× Kelly gives about zero growth**, and more than that is negative.
  - Overestimating the edge is therefore far more costly than underestimating it.

### 5.2 Literature

- **Fractional Kelly trade-off.** MacLean, Thorp, Ziemba (2010), "Long-term capital growth: the good and bad properties of the Kelly and fractional Kelly capital growth criteria", *Quantitative Finance* 10(7):681-687; also the edited volume *The Kelly Capital Growth Investment Criterion* (World Scientific, 2011) [A]. https://www.worldscientific.com/worldscibooks/10.1142/7598
  - Full Kelly is optimal for asymptotic growth but very risky in the short term: its Arrow-Pratt risk aversion is about 0.
  - Fractional Kelly trades growth for security; half-Kelly gives roughly 75% of the growth with 50% of the volatility.
- **Shrinking under parameter uncertainty.** Baker & McHale (2013), "Optimal Betting Under Parameter Uncertainty: Improving the Kelly Criterion", *Decision Analysis* 10(3):189-199, doi:10.1287/deca.2013.0271 [A]. https://pubsonline.informs.org/doi/abs/10.1287/deca.2013.0271
  - Plugging an *estimated* p into Kelly overbets out of sample. They derive a shrinkage factor k < 1 on the Kelly fraction, including a "back-of-envelope" approximation, and show it improves expected utility in simulation and in tennis betting.
  - I could not access the full text for their exact formula. The standard small-edge approximation consistent with their framework follows.
- **Shrinkage approximation (my derivation).** Suppose the true edge is μ and the estimate μ̂ = μ + ε with Var(ε) = s².
  - Maximizing E[G(k·f̂)] gives **k\* ≈ μ² / (μ² + s²)**.
  - If the standard error of your edge equals the edge itself, **k\* ≈ 0.5**. If it is twice the edge, **k\* ≈ 0.2**.
- **Bayesian modified Kelly.** Chu, Wu, Swartz (2018), "Modified Kelly Criteria", *J. Quantitative Analysis in Sports* (my recollection of the venue; I verified the preprint) [A/B]. https://www.sfu.ca/~tswartz/papers/kelly.pdf
  - Bayesian decision-theoretic fractions accounting for uncertainty in p are "smaller than original Kelly" in all studied cases. The ad-hoc half and quarter Kelly have "no theoretical underpinnings", whereas their fractions do.
- **Kelly with estimated probabilities.** Metel (2017), arXiv:1701.02814 [B]: accounting for estimation error in multinomial-logit probabilities improves returns. https://arxiv.org/abs/1701.02814
- **Practice.** Uhrín, Šourek, Hubáček, Železný (2021), "Optimal sports betting strategies in practice: an experimental review", *IMA J. Management Mathematics*, arXiv:2107.08827 [A]. https://arxiv.org/abs/2107.08827
  - Across horse racing, basketball and soccer, an **adaptive fractional Kelly** was the most robust choice.
- **Prediction markets specifically.** Meister (2024), "Application of the Kelly Criterion to Prediction Markets", arXiv:2412.14144 [B]. https://arxiv.org/abs/2412.14144
  - A KL-divergence analysis of the growth lost to misjudged bias and to a mis-set fraction.
- **Counterpoint.** Hsieh, Barmish, Gubner (2016), "Kelly Betting Can Be Too Conservative", IEEE CDC, arXiv:1710.01786 [A].
  - With *empirical* distributions, Kelly can be too conservative in some settings. This is not the typical case for noisy probability estimates.

### 5.3 Key identity: shrinking toward the market price is the same as fractional Kelly

- **Identity.** If the final probability is a linear pool p_c = q + w·(p̂ − q), then f\*(p_c) = w·(p̂ − q)/(1 − q) = **w·f\*(p̂)**. With logit pooling the identity holds approximately for small differences.
- **Double shrinkage.** Fusing the LLM with the market at weight w (§1.4: w ≈ 0.2-0.35) and then applying a Kelly fraction c gives an effective fraction **w·c of the raw-LLM Kelly bet**. For example, 0.33 × 0.5 ≈ 0.17, or 0.25 × 0.25 ≈ 0.06.
- **Recommendation.** Decide the total deliberately and do not "double shrink" by accident. Given that live results are mostly negative, a small total is appropriate.

### 5.4 Empirical evidence in prediction markets

**Raven-Agent.** Wang, Wang, Deng, Tang (2026), "Beyond Forecasting: The Belief-to-Trade Layer in Prediction-Market Agents", arXiv:2607.03015 [B]. https://arxiv.org/abs/2607.03015

- Live Polymarket data with archived forecasts replayed against fixed trading policies; small sample.

| Policy | ROI | Sharpe (weighted) |
|---|---|---|
| Forecast-only, every positive-edge trade at $10 | **-10.7%** | -0.20 |
| Edge-proportional sizing | **-55.5%** | -0.91 |
| Edge filter > 5%, fixed $10 | -9.3% | -0.16 |
| Raven, fixed stakes | -4.7% | -0.09 |
| **Raven full (quarter-Kelly)** | **+15.9%** (95% bootstrap CI [+3.8%, +30.0%]) | **+0.42** |

- **Raven's sizing rule:** sᵢ = ¼·max(0, (pᵢ − qᵢ)/(1 − qᵢ))·W.
- **Ranking by capital lock-up:** ρᵢ = (pᵢ/qᵢ − 1)·30/max(Tᵢ, 1), keeping the top 4 candidates.
- **Hard caps outside the LLM:** per-trade notional, aggregate exposure, per-event concentration, stop-loss, drawdown halt, and rejection of stale data.
- **Lesson:** "concentrating capital on confidently wrong high-edge predictions amplifies losses." Deterministic risk controls beat prompt-level risk guidance.

**Prediction Arena.** Zhang, Liu, Johansson, Yitayew, Ohly, Li (2026), arXiv:2604.07355 [B]. https://arxiv.org/abs/2604.07355

- Six frontier models, $10k each, **live** from 2026-01-12 to 2026-03-09.
- **Kalshi returns: all negative, -16.0% to -30.8%.**
  - gemini-3-pro-preview: **-30.5%** over 664 trades with 27.9% accuracy.
  - claude-opus-4.5: -25.9% over 886 trades.
- **Polymarket**, where models chose their own markets, over the same period: -0.09% to -2.7%.
- Paper-trading cohort 2 (only 3 days): gemini-3.1-pro +6.0%, claude-opus-4.6 -10.1%.
- **Token usage and research volume did not correlate with returns.**
- Failure modes:
  - Overtrading.
  - Cutting winners and holding losers.
  - Correlated positions: one model lost 9% in a single session.
  - A 15% concentration cap was imposed.

---

## 6. LLM trading agents 2024-2026

### 6.1 Systems and their claims

- **FinMem.** Yu et al. (2023), arXiv:2311.13743 [B]. Layered memory and character design. https://arxiv.org/abs/2311.13743
- **FinAgent.** Zhang et al. (2024), KDD 2024, arXiv:2402.18485 [A]. Multimodal and tool-augmented; claims more than 36% average profit improvement over 9 baselines on 6 datasets. https://arxiv.org/abs/2402.18485
- **FinCon.** Yu et al. (2024), NeurIPS 2024, arXiv:2407.06567 [A]. Multi-agent with "conceptual verbal reinforcement".
- **StockAgent.** Zhang et al. (2024), arXiv:2407.18957 [B]. A simulated trading environment.
- **TradingAgents.** Xiao, Sun, Luo, Wang (2024), arXiv:2412.20138 [B]. https://arxiv.org/abs/2412.20138
  - Analyst, bull and bear researcher, trader and risk agents.
  - **Backtest of only 3 months** (2024-01-01 to 2024-03-29) on 6 mega-caps. Reports, for example, AAPL cumulative return 26.62% versus buy-and-hold -5.23%, **Sharpe 8.21**, max drawdown 0.91%.
  - A Sharpe above 5 over 3 months is a red flag for overfitting, leakage or noise.

### 6.2 Critiques and replications

- **Long-horizon replication.** Li et al. (2025), "Can LLM-based Financial Investing Strategies Outperform the Market in Long Run?" (FINSABER), **KDD 2026**, arXiv:2505.07078 [A]. https://arxiv.org/abs/2505.07078
  - Over 20 years and more than 100 symbols, previously reported LLM advantages "deteriorate significantly".
  - LLM strategies are too conservative in bull markets and too aggressive in bear markets.
- **Profit mirage.** Li, Zeng, Xing, Xu, Xu (2025), "Profit Mirage: Revisiting Information Leakage in LLM-based Financial Agents", arXiv:2510.07920 [B]. https://arxiv.org/abs/2510.07920
  - Backtested returns "evaporate once the model's knowledge window ends". Introduces the FinLake-Bench leakage benchmark.
- **The Alpha Illusion.** Ye et al. (2026), arXiv:2605.16895 [B]. https://arxiv.org/abs/2605.16895
  - Audit of FinCon, FinMem, TradingAgents, FinAgent, QuantAgent and FLAG-Trader.
  - Crossing the pretraining cutoff cuts **FinMem total return by about 72%** and **QuantAgent Sharpe by about 51%**.
  - **35 of 40** system-by-friction cells were not modeled.
  - A one-year reproduction of TradingAgents plus QuantAgent saw portfolio **Sharpe fall from 0.43 to 0.22 after costs**, below buy-and-hold.
  - Sharpe CI half-widths (Lo 2002) exceed the gaps between systems.
  - Recommended protocols: post-cutoff evaluation, dynamic universe, counterfactual robustness, ECE, full frictions, and single-agent baselines.
- **Look-ahead in point-in-time models.** Benhenda (2026), "Look-Ahead-Bench", arXiv:2601.13770 [B]. Standard LLMs show significant look-ahead bias, measured as alpha decay across regimes. https://arxiv.org/abs/2601.13770
- **Distraction effect.** Glasserman & Lin (2024) [A], §3.1.

### 6.3 Live evaluations

- **Alpha Arena Season 1** (nof1, 2025-10-18 to 2025-11-03) [C, press and blog]. https://www.iweaver.ai/blog/alpha-arena-ai-trading-season-1-results/
  - $10k each, crypto perpetuals on Hyperliquid, identical prompts.

  | Model | Return |
  |---|---|
  | Qwen3-Max | +22.3% |
  | DeepSeek V3.1 | +4.9% |
  | Claude Sonnet 4.5 | -30.8% |
  | Grok 4 | -45.3% |
  | **Gemini 2.5 Pro** | **-56.7%** |
  | GPT-5 | -62.7% |

  - The winner made only about 43 trades.
  - With one 2-week run and leverage, this is essentially **no statistical evidence** of skill.
- **LiveTradeBench.** Yu, Li, You (2025), arXiv:2511.03628 [B]. https://arxiv.org/abs/2511.03628
  - 21 LLMs, 50 days live, across US stocks and **Polymarket**.
  - **LMArena scores do not predict trading performance.**
- **Other live benchmarks:** Prediction Arena, PolyBench and Prophet Arena (§1.4, §3.4, §5.4).

### 6.4 Pitfalls checklist, with evidence

1. **Look-ahead through parametric memory.** Only evaluate after the model cutoff. Leakage can cut measured returns by 50-70% (Alpha Illusion).
2. **Look-ahead through retrieval.** Date-filtered search leaks for 71-81% of questions, with Brier 0.10 versus 0.24 (El Lahib). Use your own timestamped archive.
3. **Distraction and entity priors.** Anonymize entities in robustness tests (Glasserman & Lin).
4. **Overconfidence and rigid confidence.** PolyBench models held 0.8-0.9 confidence regardless of domain. RLHF hedging runs the opposite way (AIA). Directional optimism affects 14 of 16 models (OptimismBench). The bias sign is model-specific, so calibrate empirically.
5. **Short windows.** 3-month or 2-week tests cannot distinguish skill from luck (Lo-2002 CIs; Alpha Illusion).
6. **Frictions.** Spreads of 2-5¢, taker fees up to 1.75¢ per share, and slippage above $1k size (Prediction Arena; PolyBench; Polymarket docs).
7. **Correlated positions and monoculture.** ρ ≈ 0.7 across agents (Begin et al.), and single-session correlated drawdowns (Prediction Arena).
8. **LLM as end-to-end trader.** Prompt-level risk rules are unreliable. Put deterministic sizing and limits outside the LLM (Raven; Alpha Illusion).

---

## 7. DESIGN IMPLICATIONS

Numbers are starting values justified by the cited evidence. Every one of them should be re-fitted on the system's own resolved forecasts once there are enough, roughly ≥ 200-300 markets.

### Forecasting pipeline

1. **The market price is the prior, not an input to beat.** Compute p_final = σ(w·logit(p_LLM,cal) + (1−w)·logit(q_mid)) with **w = 0.25 as the default** and a range of 0.20-0.35.
   - Halawi found 4:1 crowd:LM optimal (w = 0.2). AIA learned w = 0.33 [0.12, 0.47] on liquid markets.
   - Allow w up to about 0.5 only for thin, new or low-volume markets. AIA gave its forecaster weight 0.87 on less-liquid platforms.
   - Refit w by logistic regression once you have ≥ 200 resolved forecasts.
2. **Produce the LLM forecast blind to the market price, then fuse statistically.** In Schoenegger Study 2, LLMs that updated on the crowd were beaten by a simple average.
   - Optionally add a second "crowd-adjust" pass that re-examines evidence when |p_LLM − q| > 15 pp (Cassi gained about 0.01 Brier).
   - The final number must still come from the formula in rule 1.
3. **Ensemble size and composition.**
   - Use **6-10 samples per question**. Halawi used 6; AIA's gains plateau after 5 and it adopts 10; Turtel used 7; Metaculus bots used 5.
   - Split the samples across **at least 2 model families**, for example Gemini Pro plus Flash plus one non-Google model. Same-model errors correlate at ρ ≈ 0.7, so 10 same-model agents behave like about 1.4 forecasters.
   - **Aggregate with the median or trimmed mean of log-odds.** Never use an LLM as the aggregator; universal self-consistency was worse than no ensemble.
4. **Use Gemini Pro for the probability and Flash for triage.** Measured gaps:
   - Gemini 3 Pro 0.134 versus Gemini 2.5 Flash 0.179 Brier on the same 1,499 questions.
   - Gemini 2.5 Flash had the worst ECE (0.067) among reasoning models in Prophet Arena.
   - Gemini 2.5 Pro was only mid-pack (0.146) on AIA MarketLiquid.

   Use Flash for relevance filtering, deduplication, query generation and "is this headline material to market X?". Re-benchmark each quarter; model choice matters more than scaffolding (Metaculus).
5. **Recalibrate before fusing.**
   - Fit Platt scaling in logit space: logit(p_cal) = a + b·logit(p_ens).
   - Until about 150 resolutions exist, use **b = 1.5** (AIA used √3 ≈ 1.73; the benchmark optimum was 2.27) and a = 0. Metaculus bots gained about 0.016 Brier from Platt scaling.
   - Do **not** use GJP human-crowd factors of 2.4-3.1; the LLM samples share information.
   - Clip p_cal to **[0.03, 0.97]**.
6. **Retrieval.**
   - Feed **10-20 relevance-ranked article summaries**; 15 was optimal for Halawi.
   - **Abstain if fewer than 5 relevant articles** are found.
   - Tag each article as reported fact or speculation. Retrieval hurt in rumour-heavy domains: entertainment regressions in Hindcast, and accuracy falling from 68% to 40-56% in Karkar & Chopra.
   - Keep prompts simple: base rates plus a scratchpad. Elaborate "Bayesian reasoning" prompts significantly hurt.

### Market selection and signal

7. **Trade where LLMs have relative skill.**
   - Market mid in **[0.15, 0.85]**.
   - At least **3 days to resolution**; skip the final 24 hours. LLMs are worst near resolution and on strong-consensus markets (TimeSeek, Prophet Arena). Halawi only beat the crowd with the crowd in [0.3, 0.7] and early retrieval dates.
   - Deprioritize markets resolving in more than 90 days, because of the long-horizon bias (Page & Clemen) and capital lock-up.
8. **Never buy longshots below 10¢ on model conviction alone.** Longshot buyers lose 6-19% on Polymarket and more than 60% on Kalshi. Treat any model p that is more than 2× the market price on a sub-10¢ contract as a probable model error.
9. **News-reaction module: assume you are late.**
   - Log the market price at the article's *publication* timestamp and at ingestion time.
   - If the market has already moved **at least 50% of the LLM-predicted move**, do not trade it. Liquid markets absorb news within seconds to minutes (Busse & Green; Croxson & Reade), and Polymarket moves usually precede media citations (74%).
   - Aim the module at (a) related markets that the headline does not name, (b) low-prominence markets (5-pp move cost under about $10k), and (c) post-news drift after negative or surprising news.
   - Expect the half-life of any news edge to be about 1 year: Lopez-Lira & Tang Sharpe fell from 6.5 to 1.2 in 2.5 years.
10. **Consistency and arbitrage first.**
    - Enforce Σ P = 1 across mutually exclusive outcomes and logical constraints across related markets before directional forecasting (Paleka et al.).
    - Trade violations of at least **3¢ net of fees**. Documented examples: about $40M of realized Polymarket arbitrage, and 3-7¢ cross-venue gaps. This is the best-evidenced edge in the literature.
11. **TimesFM is a baseline and volatility band, not a signal.**
    - Use **TimesFM 2.5** (Apache-2.0), not TimesFM-3, whose weights are non-commercial.
    - Forecast in logit space. Always benchmark against the random-walk (no-change) forecast with a Diebold-Mariano test. Zero-shot TSFMs have R² from -1.4% to -2.8% on returns and lose to Log-HAR on volatility (TimesFM 2.5 QLIKE ratio 1.09-1.33).
    - Use its 10-90% quantile band to flag "abnormal" moves for the news module.
    - Admit it as a stacking feature only if it beats the random walk out of sample at p < 0.05.

### Trade filter, sizing and risk

12. **Edge threshold.** Trade only when **|p_final − q_exec| ≥ half-spread + fee + 2 pp**, where fee = feeRate·q(1 − q) and feeRate is 0.04-0.07 (0 for geopolitics).
    - In practice this means at least **4-5 pp net for taker orders** and at least 2-3 pp for maker orders.
    - Also require the edge to exceed **1 standard error** of the ensemble (bootstrap over members), and that **70% or more of ensemble members sit on the same side of q**. Within-crowd agreement as a filter improved returns in "Can LLM Forecasters Profit?"
    - A fixed 5% edge filter *alone* still lost 9.3% in Raven, so thresholds are necessary but not sufficient.
13. **Kelly fraction.** Size with f = **c·(p_final − q_eff)/(1 − q_eff)** for YES, and f = c·(q_eff − p_final)/q_eff for NO, with **c = 0.25** (range 0.2-0.35).
    - Because p_final is already shrunk toward the market with w ≈ 0.25, the effective fraction of raw-LLM Kelly is about 0.06.
    - This is deliberate, per the §5.3 identity and the Baker & McHale shrinkage k\* ≈ μ²/(μ² + s²), and given that live LLM trading has been mostly negative.
    - Raven's only positive result used quarter-Kelly. Edge-proportional sizing without filtering lost 55.5%.
14. **Hard risk limits, enforced in code and never by the LLM:**

    | Limit | Value |
    |---|---|
    | Per market | ≤ 2% of bankroll |
    | Per correlated event cluster | ≤ 10% |
    | Total open exposure | ≤ 40% |
    | Drawdown halt (stop new positions) | 15% |
    | Stale data | Reject quotes older than 60 s |

    Correlated positions caused a 9% single-session loss in Prediction Arena, and deterministic controls beat prompt-level ones (Raven).
15. **Rank candidates by edge per day of capital lock-up.** Use ρ = (p/q − 1)·30/max(T_days, 1), following Raven, and take the top K ≤ 5 per cycle.
16. **Execution.**
    - Default to **post-only limit orders**. Makers pay no fee and get rebates; on Kalshi, makers averaged -9.6% versus takers -31.5%.
    - Cap order size at **≤ 20% of visible depth within 2¢ of mid**; PolyBench returns collapsed at $1k size.
    - Hold to resolution unless new information arrives. Prediction Arena models that held to settlement did better, and cutting winners early was a failure mode.
17. **Debias the market price before fusion only if your data supports it.**
    - Literature calibration slopes are around 1.0-1.13 (favourites underpriced) and category-dependent: politics is underconfident and sports is reversed.
    - Fit a per-category logit slope on resolved markets. Leave it at 1.0 until at least 500 resolutions per category.

### Evaluation and operations

18. **Backtest hygiene.**
    - Only evaluate on questions that open *and* resolve after the model's knowledge cutoff.
    - Never use search-engine date filters (71-81% leakage; Brier 0.10 versus 0.24). Replay only your own timestamped RSS archive.
    - Run an entity-anonymized variant as a robustness check.
19. **Promotion gate from paper to real money.** Require **at least 300 resolved markets across at least 3 categories**, and all of the following:
    - Combined-forecast Brier below market Brier (paired bootstrap p < 0.05).
    - ECE < 0.05.
    - Simulated net-of-fee ROI above 0 with the 95% CI excluding 0.

    Short windows of 2 weeks to 3 months are uninformative (Alpha Illusion; Alpha Arena). Report results per category.
20. **Cost discipline.** Budget about **$1-2 per question-refresh**, roughly 20-30 LLM calls (Metaculus winners averaged $1.40 and 28 calls). Research volume and tokens were **uncorrelated** with live returns (Prediction Arena), so do not scale spend in pursuit of edge.
21. **Recalibration cadence.** Refit the Platt parameters (a, b), the market weight w, and the per-category thresholds **monthly** on a trailing window of at least 200 resolutions. Refit immediately after any model version change: bias sign and size vary by provider (OptimismBench), and model quality improves by about 0.015 Brier per year.
22. **Label-free monitoring.**
    - Track the consistency-violation rate across related markets (Paleka).
    - Track the distribution of p_LLM − q.
    - Alert if mean |p_LLM − q| rises by more than 50% week over week. That usually signals a retrieval failure, a model regression or definition drift, not a sudden edge.

---

## 8. Evidence gaps and items I could not verify

- **"Beyond Accuracy: Can LLM Forecasters Profit on Prediction Markets?"** (OpenReview TSA5kRUKZv): only an abstract snippet was available, with no numbers.
- **Baker & McHale (2013)**: I could not access the exact shrinkage formula. The k\* = μ²/(μ² + s²) approximation is my own derivation in the same spirit.
- **Chu, Wu & Swartz**: the journal venue is from memory; the preprint itself is verified.
- **Satopää et al. (2014)**: the extremizing range d ∈ [1.161, 3.921] comes from the Powell et al. (2024) description of that paper, not from reading it directly.
- **Polymarket calibration slopes (1.01-1.13) and the 2.1 pp calibration error**: these come from search-result summaries of recent preprints, not verified in full text.
- **FutureSearch BTF-3 leaderboard** model names (for example "Claude Opus 5" and "GPT-6 Astra") were read from the live page and not independently verified.
- **No rigorous study found on:**
  - RSS versus newswire latency.
  - TSFMs forecasting prediction-market price paths.
  - Latency-controlled LLM prediction of Polymarket reactions to specific news items.
- **Sample sizes.** Most prediction-market LLM trading evidence (Raven, Prediction Arena, PolyBench, Alpha Arena) uses small samples or short windows. Positive results (Raven +15.9%, Turtel ROI > 10%) are fragile. Negative live results are more numerous.
- **The superforecaster "parity" claims** compare 2026 AI systems against 2024 human forecasts made on different questions.

---

## 9. Reference list (URLs)

**LLM forecasting**
- Halawi et al. 2024 — https://arxiv.org/abs/2402.18563
- Schoenegger et al. 2024 (Science Advances) — https://www.science.org/doi/10.1126/sciadv.adp1528
- Schoenegger et al. 2024 AI-augmented — https://arxiv.org/abs/2402.07862
- Karger et al. ForecastBench (ICLR 2025) — https://arxiv.org/abs/2409.19839
- FRI parity post (Jul 2026) — https://forecastingresearch.substack.com/p/ai-models-have-likely-reached-parity
- FRI "closing the gap" (Jan 2026) — https://forecastingresearch.substack.com/p/llms-are-closing-the-gap-on-human
- Metaculus Q2 2025 benchmark — https://www.lesswrong.com/posts/Surnjh8A4WjgtQTkZ/q2-ai-benchmark-results-pros-maintain-clear-lead
- AI forecasting in 2026 synthesis — https://forum.effectivealtruism.org/posts/Spyz3wESZu2eeqhDj/ai-forecasting-in-2026-what-11-analyses-say
- AIA Forecaster — https://arxiv.org/abs/2511.07678
- Mantic × Thinking Machines — https://thinkingmachines.ai/news/training-llms-to-predict-world-events/
- Turtel et al. self-play — https://arxiv.org/abs/2502.05253
- Turtel et al. outcome RL (TMLR) — https://arxiv.org/abs/2505.17989
- Lightning Rod Foresight-32B — https://blog.lightningrod.ai/p/foresight-32b-beats-frontier-llms-on-live-polymarket-predictions
- Prophet Arena — https://arxiv.org/abs/2510.17638
- TimeSeek — https://arxiv.org/abs/2604.04220
- Hindcast — https://arxiv.org/abs/2607.14051
- Bench to the Future — https://arxiv.org/abs/2506.21558
- Bosse et al. 2026 — https://arxiv.org/abs/2601.22444
- FutureX — https://arxiv.org/abs/2508.11987
- PROPHET — https://arxiv.org/abs/2504.01509
- Pitfalls (Paleka et al.) — https://arxiv.org/abs/2506.00723
- Temporal leakage in search — https://arxiv.org/abs/2602.00758
- Consistency checks — https://arxiv.org/abs/2412.18544
- Prompt engineering for forecasting — https://arxiv.org/abs/2506.01578
- Deliberating AI crowds — https://arxiv.org/abs/2512.22625
- Diverse by Reasoning — https://arxiv.org/abs/2608.24001
- Monoculture — https://arxiv.org/abs/2606.26583
- Wisdom of LLM crowds (Douven) — https://arxiv.org/abs/2607.18269
- OptimismBench — https://arxiv.org/abs/2607.26981
- Future is unevenly distributed — https://arxiv.org/abs/2511.18394
- Lu 2025 — https://arxiv.org/abs/2507.04562
- Pratt et al. 2024 — https://arxiv.org/abs/2406.04446
- Can LLM Forecasters Profit (OpenReview) — https://openreview.net/forum?id=TSA5kRUKZv

**Aggregation**
- Ranjan & Gneiting 2010 — https://academic.oup.com/jrsssb/article/72/1/71/7076442
- Satopää et al. 2014 — https://econpapers.repec.org/RePEc:eee:intfor:v:30:y:2014:i:2:p:344-356
- Baron et al. 2014 — https://pubsonline.informs.org/doi/10.1287/deca.2014.0293
- Powell, Satopää, MacKay, Tetlock 2024 — https://eprints.whiterose.ac.uk/id/eprint/188361/
- Neyman & Roughgarden 2022 — https://dl.acm.org/doi/abs/10.1145/3490486.3538243
- Sevilla 2021 (geometric mean of odds) — https://forum.effectivealtruism.org/posts/sMjcjnnpoAQCcedL2
- Rothschild 2009 — https://academic.oup.com/poq/article/73/5/895/1868587

**News and markets**
- Lopez-Lira & Tang — https://arxiv.org/abs/2304.07619
- Glasserman & Lin — https://arxiv.org/abs/2309.17322
- Busse & Green 2002 — https://econpapers.repec.org/RePEc:eee:jfinec:v:65:y:2002:i:3:p:415-437
- Croxson & Reade 2014 — https://onlinelibrary.wiley.com/doi/abs/10.1111/ecoj.12033
- Snowberg, Wolfers, Zitzewitz 2007 — https://academic.oup.com/qje/article-abstract/122/2/807/1942142
- Page & Clemen 2013 — https://academic.oup.com/ej/article-abstract/123/568/491/5079498
- Bürgi, Deng, Whelan (Kalshi) — https://www.karlwhelan.com/Papers/Kalshi.pdf
- Cardozo & Rivero-Wildemauwe (Polymarket FLB) — https://arxiv.org/abs/2609.12878
- Le 2026 (domain calibration) — https://arxiv.org/abs/2602.19520
- Clinton & Huang 2025 — https://ideas.repec.org/p/osf/socarx/d5yx2_v1.html
- Gebele & Matthes 2026 — https://arxiv.org/abs/2601.01706
- Saguillo et al. 2025 (arbitrage) — https://arxiv.org/abs/2508.03474
- Dubach 2026 (microstructure) — https://arxiv.org/abs/2604.24366
- Ibrahim & Zaki 2026 — https://arxiv.org/abs/2609.06005
- PolyBench — https://arxiv.org/abs/2604.14199
- PolySwarm — https://arxiv.org/abs/2604.03888
- Polymarket fees — https://docs.polymarket.com/trading/fees

**Time-series foundation models**
- TimesFM (ICML 2024) — https://arxiv.org/abs/2310.10688
- TimesFM repo (2.5, 3.0, licences) — https://github.com/google-research/timesfm
- TimesFM-3 blog — https://research.google/blog/timesfm-3-a-zero-shot-foundation-model-for-multivariate-forecasting/
- GIFT-Eval — https://arxiv.org/abs/2410.10393
- Chronos-2 — https://arxiv.org/abs/2510.15821
- TiRex — https://arxiv.org/abs/2505.23719
- Toto — https://arxiv.org/abs/2505.14766
- Toto 2.0 — https://arxiv.org/abs/2605.20119
- Rahimikia et al. — https://arxiv.org/abs/2511.18578
- Noguer i Alonso & Franklin — https://arxiv.org/abs/2606.27100
- Brini (realized volatility) — https://arxiv.org/abs/2607.05291
- Goel et al. (VaR) — https://arxiv.org/abs/2410.11773

**Kelly**
- MacLean, Thorp, Ziemba — https://www.worldscientific.com/worldscibooks/10.1142/7598
- Baker & McHale 2013 — https://pubsonline.informs.org/doi/abs/10.1287/deca.2013.0271
- Chu, Wu, Swartz — https://www.sfu.ca/~tswartz/papers/kelly.pdf
- Uhrín et al. 2021 — https://arxiv.org/abs/2107.08827
- Metel 2017 — https://arxiv.org/abs/1701.02814
- Meister 2024 — https://arxiv.org/abs/2412.14144
- Hsieh, Barmish, Gubner — https://arxiv.org/abs/1710.01786
- Raven-Agent — https://arxiv.org/abs/2607.03015
- Prediction Arena — https://arxiv.org/abs/2604.07355

**Trading agents**
- FinMem — https://arxiv.org/abs/2311.13743
- FinAgent — https://arxiv.org/abs/2402.18485
- FinCon — https://arxiv.org/abs/2407.06567
- StockAgent — https://arxiv.org/abs/2407.18957
- TradingAgents — https://arxiv.org/abs/2412.20138
- FINSABER — https://arxiv.org/abs/2505.07078
- Profit Mirage — https://arxiv.org/abs/2510.07920
- Alpha Illusion — https://arxiv.org/abs/2605.16895
- Look-Ahead-Bench — https://arxiv.org/abs/2601.13770
- LiveTradeBench — https://arxiv.org/abs/2511.03628
- Alpha Arena S1 recap — https://www.iweaver.ai/blog/alpha-arena-ai-trading-season-1-results/

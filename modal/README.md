# MIDAS on Modal

Two Modal apps live here:

| App | File | What it runs |
|---|---|---|
| `midas-intel` | `midas_intel.py` | GPU model service: **TimesFM** price-path forecasts and **Laya** System-1 decisions, behind one authenticated HTTPS API |
| `midas-engine` | `engine_app.py` | The Node.js engine (`apps/engine`): an always-on leader plus optional ledger task workers |

| File | Purpose |
|---|---|
| `core_math.py` | Pure numpy: logit/sigmoid, random-walk fallback, pinball loss, rolling-origin backtest, request validation, Laya result normalisation, bearer check. No modal/torch imports. |
| `intel_app.py` | Model runtimes (lazy loaders) + the FastAPI app. No top-level `modal` import. |
| `midas_intel.py` | Thin Modal wrapper: images, GPU classes, the ASGI function. |
| `serve_local.py` | The same API without Modal (dev boxes, CPU hosts). |
| `engine_app.py` | Modal app for the Node engine. |
| `test_core_math.py` | Unit tests: `python3 -m pytest modal/test_core_math.py -q` |

Do **not** add an `__init__.py` to this folder: it would make `modal/` a package that shadows the `modal` library.

---

## 1. Deploy `midas-intel`

```bash
pip install -r modal/requirements.txt        # modal, numpy, pytest
modal token new                              # once per machine
modal secret create midas-intel MIDAS_MODAL_TOKEN="$(openssl rand -hex 32)"   # optionally add HF_TOKEN=hf_...
modal deploy modal/midas_intel.py
```

`modal deploy` prints the API URL, e.g. `https://<workspace>--midas-intel-api.modal.run`. Put it in the engine env:

```bash
MIDAS_MODAL_URL=https://<workspace>--midas-intel-api.modal.run
MIDAS_MODAL_TOKEN=<the same token as in the midas-intel secret>
```

To smoke-test both GPU classes: `modal run modal/midas_intel.py`. The first cold start downloads about 0.9 GB for TimesFM and 4.7 GB for Laya into the `midas-hf-cache` Volume (mounted at `/cache`, `HF_HOME=/cache`). Later cold starts load from the Volume.

### Deploy-time configuration

Read from your shell when you run `modal deploy` and forwarded into the containers.

| Env var | Default | Meaning |
|---|---|---|
| `MIDAS_TIMESFM_CHECKPOINT` | `google/timesfm-2.5-200m-pytorch` | HF repo id. Ids containing `timesfm-3` use the TimesFM 3 code path (see licence note below). |
| `MIDAS_TIMESFM_MAX_CONTEXT` / `_MAX_HORIZON` | `2048` / `256` | Context is truncated to the most recent N points; horizon is capped (at most 1024). |
| `MIDAS_TIMESFM_BATCH` | `32` | `per_core_batch_size`; every call is padded to a multiple of it. |
| `MIDAS_TIMESFM_GPU` / `MIDAS_LAYA_GPU` | `L4` / `T4` | Modal GPU type; `cpu` runs without a GPU. Laya on CPU takes about 0.4 s per request. |
| `MIDAS_INTEL_SCALEDOWN` | `300` | Idle seconds a GPU container stays up (and billed). |
| `MIDAS_TIMESFM_MIN_CONTAINERS` / `MIDAS_LAYA_MIN_CONTAINERS` | `0` | `1` = never cold, always billed. |
| `MIDAS_TIMESFM_MAX_CONTAINERS` / `MIDAS_LAYA_MAX_CONTAINERS` | `4` / `2` | Caps fan-out, and therefore cost. |
| `MIDAS_LAYA_PRELOAD` / `MIDAS_LAYA_BATCH` | `1` / `32` | `Router(preload=True)`; max states per forward pass. |
| `MIDAS_INTEL_BACKTEST_CHUNK` | `8` | Series per `.map()` input in `/backtest`. |

### Model and licence notes

- **TimesFM 2.5 200M** (`google/timesfm-2.5-200m-pytorch`, Apache-2.0 weights) is the default. PyPI `timesfm==3.0.2` also ships **TimesFM 3.0** (`google/timesfm-3.0-pytorch`). Its code is Apache-2.0, but its **weights are under `timesfm-non-commercial-license-v1.0`: no commercial or production use**. A trading harness should stay on 2.5 unless you have a separate licence.
- Forecasts run in **logit space** by default: prices are clipped to [1e-3, 1 − 1e-3], mapped with `logit`, and results are mapped back with `sigmoid`. Quantiles are preserved exactly because sigmoid is monotone. `point` is the median.
- TimesFM is compiled with `infer_is_positive=False`. With `True`, a market trading above 0.5 (all logits > 0) would have its forecast clamped at p ≥ 0.5. `force_flip_invariance=True` makes forecasts symmetric under p → 1 − p.
- Series with fewer than 16 points get a driftless **logit random walk** with EWMA(0.94) volatility (`model: "logit-random-walk"`). It matches `packages/core/src/forecast-local.ts`. If every series is short, the request is answered without waking a GPU.
- `step_sec` is accepted and validated but not used. TimesFM 2.5 has no frequency input, so send regularly sampled series.
- Not exposed: covariates. 2.5 has XReg `forecast_with_covariates` (needs the `xreg` extra, jax + sklearn); 3.0 has native covariates.

---

## 2. API

All POST routes require `Authorization: Bearer $MIDAS_MODAL_TOKEN` (401 otherwise; with no token configured every POST is refused). `GET /health` is public. Errors are returned as `{"error": "..."}` with status 400 (bad payload), 401, 413 (too large), 422 (bad Laya question on `/v1/systemone`), 501 (model not installed or not enabled), 503 (model failed to load; retried after 60 s) or 500.

```bash
URL=https://<workspace>--midas-intel-api.modal.run   # or http://127.0.0.1:8787 locally
AUTH="Authorization: Bearer $MIDAS_MODAL_TOKEN"
```

**GET /health** returns `{"ok": true, "deployment": "modal", "fallback": "logit-random-walk", "models": {"timesfm": {...}, "laya": {...}}}`. On Modal this is static config, so it never wakes a GPU.

```bash
curl -s $URL/health
```

**POST /forecast**: `space` is `"logit"` (default; values in [0, 1]) or `"raw"`. `quantiles` must be deciles (default `[0.1, 0.5, 0.9]`); `q10`, `q50` and `q90` are always returned, plus any other requested deciles. `model` is the checkpoint id, or `logit-random-walk` for the fallback.

```bash
curl -s $URL/forecast -H "$AUTH" -H 'content-type: application/json' -d '{
  "series": [{"id": "0xabc-YES", "values": [0.41,0.42,0.40,0.43,0.45,0.44,0.46,0.47,0.46,0.48,0.50,0.49,0.51,0.52,0.53,0.52,0.54], "step_sec": 300}],
  "horizon": 12, "quantiles": [0.1, 0.5, 0.9], "space": "logit"}'
# {"forecasts":[{"id":"0xabc-YES","point":[...12],"q10":[...],"q50":[...],"q90":[...],"model":"google/timesfm-2.5-200m-pytorch"}]}
```

**POST /backtest** runs a rolling-origin evaluation: fold k forecasts from `values[:n-k*horizon]` and scores the next `horizon` points. Series are fanned out over TimesFM containers with `.map()` in chunks. Pinball loss is averaged over q10/q50/q90 in price space against the logit random walk, with `skill = 1 - timesfm/rw` (> 0 means TimesFM wins). `coverage80` is the share of outcomes inside [q10, q90].

```bash
curl -s $URL/backtest -H "$AUTH" -H 'content-type: application/json' -d '{
  "series": [{"id": "m1", "values": [/* >= 16 + horizon points */]}], "horizon": 8, "folds": 5}'
# {"model":"google/timesfm-2.5-200m-pytorch","baseline":"logit-random-walk","horizon":8,"folds":5,"space":"logit",
#  "per_series":[{"id":"m1","folds":5,"timesfm_pinball":..,"rw_pinball":..,"skill":..,"coverage80":{"timesfm":..,"rw":..}}],
#  "aggregate":{"series":1,"folds":5,"timesfm_pinball":..,"rw_pinball":..,"skill":..,"coverage80":{...}}}
```

**POST /decide** returns MIDAS-normalised Laya answers in the TypeScript `S1Answer` shape. `model` is one of `auto` (default), `english`, `multilingual`, `typed-decisions`. All items go through one `Router.predict_batch`, which groups states by checkpoint and question schema so they share forward passes. `confidence` is Laya's calibrated `answer_confidence` (= P(reported answer)), not its entropy-based `confidence`. `latency_ms` is the item's amortised share of the batch.

```bash
curl -s $URL/decide -H "$AUTH" -H 'content-type: application/json' -d '{
  "model": "auto",
  "items": [{"state": {"market": "Will the Fed cut in October?", "news": "Fed chair signals a cut at the next meeting."},
             "questions": {
               "direction": {"type": "choice", "instructions": "Which way does this move YES?",
                             "criteria": {"up": "raises YES", "down": "lowers YES", "none": "no effect"}},
               "magnitude": {"type": "score", "instructions": "How big is the move?", "criteria": ["none", "small", "large"]},
               "resolves":  {"type": "noul", "instructions": "Does this news resolve the market?"}}}]}'
# {"results":[{"answers":{"direction":{"choice":"up","probs":{"up":0.58,...},"confidence":0.58},
#   "magnitude":{"score":1.18,"probs":{"0":..,"1":..,"2":..},"confidence":0.59},"resolves":{"noul":0.05,"confidence":0.95}},
#   "latency_ms":226.2,"model":"laya"}],"batch_latency_ms":452.4}
```

**POST /v1/systemone** uses the TypeSafe Jev wire protocol, the same one `laya-serve` exposes, so one client can talk to Jev, OpenRouter and this service. The Router output is passed through verbatim: `{model, answers, usage, routing}`. A `model` naming a Laya checkpoint or alias is honoured; anything else (e.g. `jev-latest`, or `convaiinnovations/laya`) auto-routes. The body is capped at 2 MB, with at most 64 questions and 50,000 state characters.

```bash
curl -s $URL/v1/systemone -H "$AUTH" -H 'content-type: application/json' -d '{
  "model": "jev-latest", "state": "Fed chair signals a cut at the next meeting.",
  "questions": {"resolves": {"type": "noul", "instructions": "Does this news resolve the market?", "criteria": {"true": "yes", "false": "no"}}}}'
# {"model":"laya-rl-agent","answers":{"resolves":{"type":"noul","noul":0.05,"confidence":0.95,"answer_confidence":0.95,...}},
#  "usage":{"input_tokens":149,"output_tokens":0},"routing":{"model":"english","reason":"English Latin text",...}}
```

**POST /v1/systemone/batch** takes `{"requests": [<systemone request>, ...]}` and returns `{"responses": [...]}` in order. It always uses `Router.predict_batch`, which handles mixed question sets by grouping, so no per-request loop is needed.

```bash
curl -s $URL/v1/systemone/batch -H "$AUTH" -H 'content-type: application/json' -d '{"requests": [
  {"state": "CPI came in hot.", "questions": {"resolves": {"type": "noul", "instructions": "Does this resolve the market?"}}},
  {"state": "La Fed recorta los tipos.", "model": "multilingual", "questions": {"resolves": {"type": "noul", "instructions": "Does this resolve the market?"}}}]}'
```

---

## 3. GPU cost notes

Prices are approximate Modal list prices at the time of writing; check <https://modal.com/pricing>. They are roughly: T4 $0.59/h, L4 $0.80/h, CPU $0.047 per core-hour, memory $0.008 per GiB-hour.

- **Idle costs nothing.** All intel functions scale to zero. After a request, a GPU container stays warm for `MIDAS_INTEL_SCALEDOWN` (300 s), so an isolated call costs its cold start plus 5 minutes: about $0.08 on L4.
- **An engine that calls every few minutes keeps a GPU warm around the clock**: about $19 a day for L4 and $14 a day for T4. To control this:
  1. batch all markets into one `/forecast` or `/decide` call per cycle;
  2. lower `MIDAS_INTEL_SCALEDOWN` (e.g. 60), accepting more cold starts;
  3. run Laya on CPU (`MIDAS_LAYA_GPU=cpu`, about 0.4 s per request and far cheaper);
  4. set `MIN_CONTAINERS=1` only if you need to avoid cold starts. Cold start is container boot plus model load from the Volume, and can exceed the engine's 30 s `MIDAS_MODAL_TIMEOUT_MS`.
- `/backtest` fans out over at most `MIDAS_TIMESFM_MAX_CONTAINERS` (4) L4s. Each input batches every fold of 8 series in one forward pass.
- TimesFM 2.5 needs about 1–2 GB of VRAM (200M params plus a padded batch); Laya with all three checkpoints about 5 GB in fp32. Both fit comfortably on the default GPUs.

---

## 4. Run the intel API without Modal

```bash
pip install torch --index-url https://download.pytorch.org/whl/cpu   # or a CUDA build
pip install fastapi uvicorn "timesfm[torch]==3.0.2" laya==0.3.20
MIDAS_MODAL_TOKEN=dev-token python modal/serve_local.py --port 8787          # --device cpu|cuda|auto, --host 0.0.0.0
MIDAS_INTEL_MODELS=laya MIDAS_MODAL_TOKEN=dev-token python modal/serve_local.py  # serve only Laya (TimesFM routes -> 501)
```

Models load in a background thread (on CPU: TimesFM about 3 s, Laya about 13 s once cached), and `/health` shows their progress. Measured on CPU: `/forecast` about 1 s, `/decide` with 2 items about 0.5 s.

---

## 5. Deploy the engine on Modal (`engine_app.py`)

```bash
modal secret create midas-engine \
  AI_GATEWAY_API_KEY=... \
  MIDAS_STDB_URI=wss://maincloud.spacetimedb.com MIDAS_STDB_DB=<db> MIDAS_STDB_TOKEN=<token> \
  MIDAS_MODAL_URL=<midas-intel URL> MIDAS_MODAL_TOKEN=<intel token> \
  MIDAS_CONTROL_TOKEN=<control API token>
# AI_GATEWAY_API_KEY alone covers Gemini, Jev, embeddings and alt models;
# or use GEMINI_API_KEY (+ TYPESAFE_API_KEY for Jev) instead.
modal deploy modal/engine_app.py
```

The printed URL (`https://<workspace>--midas-engine-engine-serve.modal.run`) is the engine control API. Set it in Vercel as `NEXT_PUBLIC_ENGINE_URL` (optional; the UI only links to its health check).

- **Image**: `node:22-bookworm-slim` with Python 3.11 added for Modal's runtime. The repo is copied to `/app`, excluding `node_modules`, `.git`, `.next`, `dist`, `modal/`, `docs/` and every `.env*` file, so secrets come only from the Modal secret. Then `npm ci --omit=dev -w @midas/engine` installs the engine's production dependencies (tsx included) and links `@midas/core` and `@midas/stdb-bindings` (verified locally: 106 packages, about 180 MB, no Next.js).
- **Leader**: the `Engine` class runs `node --import tsx apps/engine/src/index.ts` with `MIDAS_ROLE=all` (override at deploy with `MIDAS_LEADER_ROLE=leader`) and `MIDAS_HTTP_PORT=8080`. It uses `min_containers=1` and `max_containers=1`, and a supervisor restarts the process with backoff (1 s up to 60 s). **The engine must listen on `0.0.0.0:8080`**; Modal probes the container's external interface, so a server bound to 127.0.0.1 never becomes healthy (`startup_timeout=120`).
- **Identity**: set `MIDAS_STDB_TOKEN`. The container filesystem is ephemeral, so the fallback token file would mint a new SpacetimeDB identity on every restart.
- **Workers** (`MIDAS_ROLE=worker`) pull tasks from the SpacetimeDB ledger, so any number can run side by side:
  ```bash
  MIDAS_ENGINE_WORKERS=4 modal deploy modal/engine_app.py   # 0 (default) = none
  python -c "import modal; print(modal.Function.from_name('midas-engine','keep_workers').remote())"  # apply now
  ```
  `keep_workers` runs every 15 minutes and keeps exactly N `worker` calls running, tracked in the `midas-engine-workers` Dict. It spawns successors before the 24 h function limit (workers exit after 23.5 h) and cancels any surplus. `min_containers` cannot do this, because warm containers never execute a plain function's body. Do not scale workers with `modal run` either: that creates a temporary copy of the app, including a second leader.
- **Sizing and cost**: `MIDAS_ENGINE_CPU` (1.0 core) and `MIDAS_ENGINE_MEMORY` (1024 MiB) per container. That is about $0.055/h, or roughly $40 a month, for the always-on leader, and the same per worker.
- A redeploy briefly overlaps the old and new leader containers while the old one drains, so leader loops must tolerate a short double run.

---

## 6. What was verified and what was assumed

**Verified.** Each wheel was downloaded and its source read, then the API was exercised on CPU in this environment (torch 2.14 CPU build):

- `timesfm==3.0.2`:
  - `timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch", torch_compile=False)`.
  - `.compile(timesfm.ForecastConfig(max_context, max_horizon, normalize_inputs, per_core_batch_size, use_continuous_quantile_head, force_flip_invariance, infer_is_positive, fix_quantile_crossing, return_backcast))`.
  - `.forecast(horizon: int, inputs: list[np.ndarray]) -> (point (n,h), quantiles (n,h,10))`. Column 0 is the mean, columns 1..9 are q10..q90, and `point == quantiles[..., 5]`.
  - Context is left-padded with a mask up to `max_context` (rounded to a multiple of 32) and truncated beyond it. Horizon is rounded up to a multiple of 128, and the continuous quantile head allows at most 1024.
  - `timesfm3.TimesFM3Forecaster.from_pretrained(repo, device=None, **ModelConfig)` and `.predict_batch(contexts, horizon, return_quantiles=True, use_symmetric_averaging=...)` yield `ForecastOutput(forecast (h,), quantiles (h,9) = q10..q90)`, with `forecast == quantiles[:, 4]`.
- `laya==0.3.20`:
  - `laya.Router(models=None, device=None, token=None, max_loaded=2, default="english", auto_task_detection=False, standalone_repos=False, preload=False, ...)`.
  - `.predict(state, questions, model=None, task=None, lang=None, ..., max_len=None)` and `.predict_batch(requests, batch_size=None)`. A result has `{"model": "laya-rl-agent", "answers": {...}, "usage": {...}, "routing": {"model", "repo", "reason", ...}}`.
  - Answer fields per type: choice has `choice` and `probabilities`; score has `score` (the expected level index), `legend` and `probabilities`; noul has `noul` = P(true). Every type carries `confidence` and `answer_confidence`.
  - `laya.load(model_id_or_path="convaiinnovations/laya", device=None, token=None, subfolder=None, fast=False, ...)` returns an `Agent`.
  - Question validation mirrors `Agent._check_question`, and model resolution and size caps mirror `laya/serve.py`.
- `modal==1.5.5`: every signature named in the file docstrings was checked with `inspect`, and both apps import and validate locally. That covers definitions only; nothing was deployed from here.
- The engine image's `npm ci --omit=dev -w @midas/engine` plus `node --import tsx` loading `apps/engine/src/config.ts` and `@midas/core` were run locally (node 22.22, npm 10.9).
- The full API, via `serve_local.py`, was run end to end with the real models on CPU: auth, every route, fallbacks and error codes.

**Assumed, not verifiable without a Modal account:**

- Image builds on Modal (the `cu126` torch wheel on Modal's GPU drivers; `from_registry("node:22-bookworm-slim", add_python="3.11")`).
- GPU cold-start and inference times, and the `Volume.commit()` persistence behaviour.
- `web_server` on a class with `min_containers=1` at runtime.
- The keeper's `FunctionCall.get(timeout=0)` polling. Per the source, a running call raises the builtin `TimeoutError`.
- The `Supervisor` restart loop was not executed here.
- `apps/engine/src/index.ts` and its HTTP server on `MIDAS_HTTP_PORT` did not exist yet when this was written.

## 7. Tests

```bash
python3 -m pytest modal/test_core_math.py -q    # needs numpy + pytest only
python3 -m py_compile modal/*.py
```

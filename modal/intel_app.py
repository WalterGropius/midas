"""MIDAS intel service: TimesFM forecasts + Laya System-1 decisions behind one FastAPI app.

The same routes run two ways:
  * Modal (midas_intel.py): GPU classes wrap the runtimes below; the web app calls them remotely.
  * Local (serve_local.py): the runtimes run in-process (dev boxes, CPU-only hosts).

Nothing heavy is imported at module level (no modal / torch / timesfm / laya / fastapi), so
importing this module is cheap everywhere. NOTE: no ``from __future__ import annotations``
here -- FastAPI must be able to resolve the handler annotations defined in ``create_app``.

Verified APIs (read from the installed wheels, then exercised on CPU):
  timesfm 3.0.2  TimesFM_2p5_200M_torch.from_pretrained(repo_id, torch_compile=bool)
                 .compile(ForecastConfig(...)); .forecast(horizon, inputs) ->
                 (point (n, h), quantiles (n, h, 10)); column 0 = mean, 1..9 = q10..q90,
                 point == column 5 (median).
                 timesfm3.TimesFM3Forecaster.from_pretrained(repo_id, device=, **cfg)
                 .predict_batch(contexts, horizon, return_quantiles=True, ...) ->
                 ForecastOutput(forecast (h,), quantiles (h, 9) = q10..q90).
  laya 0.3.20    Router(preload=True, device=None).predict_batch(
                     [{"state", "questions", "model"?}], batch_size=None) -> [result]
                 result = {"model", "answers", "usage", "routing": {"model", "repo", "reason", ...}}
"""

import asyncio
import dataclasses
import json
import logging
import os
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Protocol

import numpy as np

import core_math as cm

log = logging.getLogger("midas.intel")

DEFAULT_TIMESFM_CHECKPOINT = "google/timesfm-2.5-200m-pytorch"  # Apache-2.0 weights
MAX_BODY_BYTES = 16 * 1024 * 1024
MAX_SYSTEMONE_BODY_BYTES = 2 * 1024 * 1024  # same cap as laya.serve
LOAD_RETRY_SECONDS = 60.0  # after a (non-import) load failure, retry at most this often

# Env vars that configure the runtimes; midas_intel.py forwards them into Modal containers.
CONFIG_ENV_VARS = (
    "MIDAS_TIMESFM_CHECKPOINT",
    "MIDAS_TIMESFM_MAX_CONTEXT",
    "MIDAS_TIMESFM_MAX_HORIZON",
    "MIDAS_TIMESFM_BATCH",
    "MIDAS_TIMESFM_TORCH_COMPILE",
    "MIDAS_TIMESFM_DEVICE",
    "MIDAS_LAYA_DEVICE",
    "MIDAS_LAYA_PRELOAD",
    "MIDAS_LAYA_BATCH",
    "MIDAS_INTEL_BACKTEST_CHUNK",
)


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    return int(raw) if raw else default


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    return default if not raw else raw in ("1", "true", "yes", "on")


class ServiceError(Exception):
    """Error with an HTTP status: 501 package missing / model disabled, 503 load failure."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ── crossing the Modal boundary: expected errors travel as plain dicts ──

_ENVELOPE = "__midas_error__"


def call_enveloped(fn: Callable[..., Any], *args: Any) -> Any:
    try:
        return fn(*args)
    except cm.ValidationError as e:
        return {_ENVELOPE: {"kind": "validation", "status": e.status, "detail": str(e)}}
    except ServiceError as e:
        return {_ENVELOPE: {"kind": "service", "status": e.status, "detail": e.detail}}


def unwrap(result: Any) -> Any:
    if isinstance(result, dict) and _ENVELOPE in result:
        err = result[_ENVELOPE]
        if err["kind"] == "validation":
            raise cm.ValidationError(err["detail"], status=err["status"])
        raise ServiceError(err["status"], err["detail"])
    return result


# ───────────────────────────── TimesFM ─────────────────────────────


@dataclasses.dataclass(frozen=True)
class TimesFMConfig:
    checkpoint: str = DEFAULT_TIMESFM_CHECKPOINT
    max_context: int = 2048  # 2.5 supports 16k; Polymarket paths rarely need more
    max_horizon: int = 256  # 2.5 compiles to a multiple of 128; quantile head <= 1024
    batch_size: int = 32  # per_core_batch_size
    torch_compile: bool = False  # inductor needs a C toolchain; off by default
    device: str | None = None  # 3.x only; 2.5 always picks cuda:0 when visible

    @classmethod
    def from_env(cls) -> "TimesFMConfig":
        return cls(
            checkpoint=os.environ.get("MIDAS_TIMESFM_CHECKPOINT", "").strip() or DEFAULT_TIMESFM_CHECKPOINT,
            max_context=env_int("MIDAS_TIMESFM_MAX_CONTEXT", 2048),
            max_horizon=min(env_int("MIDAS_TIMESFM_MAX_HORIZON", 256), 1024),
            batch_size=env_int("MIDAS_TIMESFM_BATCH", 32),
            torch_compile=env_bool("MIDAS_TIMESFM_TORCH_COMPILE", False),
            device=os.environ.get("MIDAS_TIMESFM_DEVICE", "").strip() or None,
        )

    @property
    def is_v3(self) -> bool:
        return "timesfm-3" in self.checkpoint.lower()

    @property
    def family(self) -> str:
        return "timesfm-3" if self.is_v3 else "timesfm-2.5"


class _TimesFM25:
    """TimesFM 2.5 200M (torch) from the ``timesfm`` package -- verified by a CPU run."""

    def __init__(self, cfg: TimesFMConfig) -> None:
        import timesfm

        model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(cfg.checkpoint, torch_compile=cfg.torch_compile)
        model.compile(
            timesfm.ForecastConfig(
                max_context=cfg.max_context,
                max_horizon=cfg.max_horizon,
                normalize_inputs=True,
                per_core_batch_size=cfg.batch_size,
                use_continuous_quantile_head=True,
                force_flip_invariance=True,  # logit space: symmetric under p -> 1 - p
                infer_is_positive=False,  # would clamp logits >= 0, i.e. p >= 0.5
                fix_quantile_crossing=True,
            )
        )
        self.model = model
        self.max_context = model.forecast_config.max_context  # rounded to patch multiples
        self.max_horizon = model.forecast_config.max_horizon
        self.device = str(model.model.device)

    def forecast(self, contexts: list[np.ndarray], horizon: int) -> tuple[np.ndarray, np.ndarray]:
        point, quantiles = self.model.forecast(horizon=horizon, inputs=list(contexts))  # it pads the list in place
        return np.asarray(point), np.asarray(quantiles)[..., 1:10]  # drop the mean column


class _TimesFM3:
    """TimesFM 3.x via ``timesfm3`` -- verified by a CPU run. Weights are NON-COMMERCIAL."""

    def __init__(self, cfg: TimesFMConfig) -> None:
        from timesfm3 import TimesFM3Forecaster

        self.model = TimesFM3Forecaster.from_pretrained(
            cfg.checkpoint, device=cfg.device, per_core_batch_size=cfg.batch_size
        )
        self.max_context = min(cfg.max_context, self.model.global_context)
        self.max_horizon = cfg.max_horizon
        self.device = str(self.model.device)

    def forecast(self, contexts: list[np.ndarray], horizon: int) -> tuple[np.ndarray, np.ndarray]:
        outs = list(
            self.model.predict_batch(list(contexts), horizon=horizon, return_quantiles=True, use_symmetric_averaging=True)
        )
        return np.stack([o.forecast for o in outs]), np.stack([o.quantiles for o in outs])  # q10..q90 sorted


class TimesFMRuntime:
    """Lazily loaded TimesFM with the MIDAS request/response contract. Thread-safe."""

    def __init__(self, cfg: TimesFMConfig | None = None) -> None:
        self.cfg = cfg or TimesFMConfig.from_env()
        self._lock = threading.Lock()  # guards loading and serialises inference
        self._model: _TimesFM25 | _TimesFM3 | None = None
        self._error: ServiceError | None = None
        self._failed_at = 0.0
        self._load_seconds: float | None = None

    def load(self) -> None:
        with self._lock:
            self._load_locked()

    def _load_locked(self) -> None:
        if self._model is not None:
            return
        err = self._error
        if err is not None and (err.status == 501 or time.monotonic() - self._failed_at < LOAD_RETRY_SECONDS):
            raise err
        t0 = time.perf_counter()
        try:
            self._model = (_TimesFM3 if self.cfg.is_v3 else _TimesFM25)(self.cfg)
        except ImportError as e:  # package missing in this image/venv
            self._error = ServiceError(501, f"timesfm is not installed ({e}); pip install 'timesfm[torch]'")
        except Exception as e:  # download / checkpoint / CUDA failure: retry later
            log.exception("TimesFM load failed")
            self._error = ServiceError(503, f"failed to load {self.cfg.checkpoint}: {e!r}")
        if self._model is None:
            self._failed_at = time.monotonic()
            assert self._error is not None
            raise self._error
        self._error = None
        self._load_seconds = round(time.perf_counter() - t0, 2)
        log.info("TimesFM %s loaded on %s in %.1fs", self.cfg.checkpoint, self._model.device, self._load_seconds)

    def info(self) -> dict[str, Any]:
        """Cheap status snapshot; never blocks on a load in progress."""
        m = self._model
        return {
            "checkpoint": self.cfg.checkpoint,
            "family": self.cfg.family,
            "loaded": m is not None,
            "device": m.device if m else None,
            "max_context": m.max_context if m else self.cfg.max_context,
            "max_horizon": m.max_horizon if m else self.cfg.max_horizon,
            "load_seconds": self._load_seconds,
            "error": self._error.detail if self._error else None,
        }

    def forecast_contexts(
        self, contexts: Sequence[Sequence[float]], horizon: int, space: str, quantiles: Sequence[float]
    ) -> list[dict[str, Any]]:
        """Batch-forecast raw (response-space) contexts; each result has point/q*/model."""
        with self._lock:
            self._load_locked()
            model = self._model
            assert model is not None
            prepared = [cm.prepare_context(c, space, model.max_context) for c in contexts]
            point, deciles = model.forecast(prepared, horizon)
        return [
            {
                **cm.decode_deciles(
                    point[j], deciles[j], space, quantiles, nonneg=space == "raw" and float(np.min(c)) >= 0.0
                ),
                "model": self.cfg.checkpoint,
            }
            for j, c in enumerate(contexts)
        ]

    def forecast(self, req: Mapping[str, Any]) -> dict[str, Any]:
        """POST /forecast. Series shorter than MIN_CONTEXT get the logit random walk."""
        req = cm.validate_forecast_request(req, max_horizon=self.cfg.max_horizon)
        series, horizon = req["series"], req["horizon"]
        long_idx = [i for i, s in enumerate(series) if len(s["values"]) >= cm.MIN_CONTEXT]
        out: list[dict[str, Any] | None] = [None] * len(series)
        if long_idx:
            fcs = self.forecast_contexts([series[i]["values"] for i in long_idx], horizon, req["space"], req["quantiles"])
            for i, fc in zip(long_idx, fcs):
                out[i] = {"id": series[i]["id"], **fc}
        for i, s in enumerate(series):
            if out[i] is None:
                out[i] = {"id": s["id"], **cm.random_walk_forecast(s["values"], horizon, req["quantiles"], req["space"])}
        return {"forecasts": out}

    def backtest(self, series: Sequence[Mapping[str, Any]], horizon: int, folds: int, space: str = "logit") -> list[dict[str, Any]]:
        """Rolling-origin pinball loss for a chunk of series (all folds in one batch)."""

        def fn(contexts: list[np.ndarray], h: int) -> list[dict[str, Any]]:
            return self.forecast_contexts(contexts, h, space, cm.REQUIRED_QUANTILES)

        return cm.backtest_series(series, horizon, folds, fn, space=space)


# ───────────────────────────── Laya ─────────────────────────────


@dataclasses.dataclass(frozen=True)
class LayaConfig:
    device: str | None = None  # None = cuda if available, else cpu (Laya decides)
    preload: bool = True  # Router(preload=True): all three checkpoints resident
    batch_size: int | None = 32  # max states per forward pass

    @classmethod
    def from_env(cls) -> "LayaConfig":
        device = os.environ.get("MIDAS_LAYA_DEVICE", "").strip().lower()
        return cls(
            device=None if device in ("", "auto") else device,
            preload=env_bool("MIDAS_LAYA_PRELOAD", True),
            batch_size=env_int("MIDAS_LAYA_BATCH", 32) or None,
        )


class LayaRuntime:
    """Lazily built ``laya.Router`` with batch inference. Thread-safe."""

    def __init__(self, cfg: LayaConfig | None = None) -> None:
        self.cfg = cfg or LayaConfig.from_env()
        self._lock = threading.Lock()  # guards construction
        self._infer_lock = threading.Lock()  # one forward pass at a time, like laya.serve
        self._router: Any = None
        self._error: ServiceError | None = None
        self._failed_at = 0.0
        self._load_seconds: float | None = None

    def load(self) -> Any:
        with self._lock:
            if self._router is not None:
                return self._router
            err = self._error
            if err is not None and (err.status == 501 or time.monotonic() - self._failed_at < LOAD_RETRY_SECONDS):
                raise err
            t0 = time.perf_counter()
            try:
                from laya import Router

                self._router = Router(preload=self.cfg.preload, device=self.cfg.device)
            except ImportError as e:
                self._error = ServiceError(501, f"laya is not installed ({e}); pip install laya")
            except Exception as e:
                log.exception("Laya load failed")
                self._error = ServiceError(503, f"failed to load Laya checkpoints: {e!r}")
            if self._router is None:
                self._failed_at = time.monotonic()
                assert self._error is not None
                raise self._error
            self._error = None
            self._load_seconds = round(time.perf_counter() - t0, 2)
            log.info("Laya loaded %s in %.1fs", self._router.loaded, self._load_seconds)
            return self._router

    def info(self) -> dict[str, Any]:
        r = self._router
        return {
            "checkpoints": sorted(cm.LAYA_CHECKPOINTS.values()),
            "loaded": list(r.loaded) if r is not None else [],
            "device": self.cfg.device or "auto",
            "load_seconds": self._load_seconds,
            "error": self._error.detail if self._error else None,
        }

    def predict_batch(self, requests: Sequence[Mapping[str, Any]]) -> tuple[list[dict[str, Any]], float]:
        """Router.predict_batch over validated {state, questions, model} requests.

        The Router groups requests by checkpoint and by question schema, so states that
        share both run in shared forward passes; results come back in input order.
        """
        router = self.load()
        payload = [
            {"state": r["state"], "questions": r["questions"], **({"model": r["model"]} if r.get("model") else {})}
            for r in requests
        ]
        t0 = time.perf_counter()
        with self._infer_lock:
            try:
                results = router.predict_batch(payload, batch_size=self.cfg.batch_size)
            except ValueError as e:  # Laya names the bad question; safe to return
                raise cm.ValidationError(str(e), status=422) from e
        return results, (time.perf_counter() - t0) * 1000.0

    def decide(self, req: Mapping[str, Any]) -> dict[str, Any]:
        """POST /decide: MIDAS-normalised answers (S1Answer shape)."""
        req = cm.validate_decide_request(req)
        results, ms = self.predict_batch([{**it, "model": req["model"]} for it in req["items"]])
        per_item = ms / max(1, len(results))  # amortised share of the batched forward passes
        return {
            "results": [cm.normalize_laya_result(r, per_item) for r in results],
            "batch_latency_ms": round(ms, 3),
        }

    def systemone(self, requests: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
        """POST /v1/systemone[/batch]: Router output passed through verbatim (Jev protocol)."""
        reqs = [cm.validate_systemone_request(r) for r in requests]
        results, _ = self.predict_batch(reqs)
        return results


def warm(runtimes: Sequence[TimesFMRuntime | LayaRuntime]) -> None:
    """Load models up front (errors are recorded on the runtime and shown in /health)."""
    for rt in runtimes:
        try:
            rt.load()
        except ServiceError as e:
            log.error("warm-up failed: %s", e.detail)


# ───────────────────────────── backends (how the web app reaches the models) ─────────────────────────────


class ForecasterBackend(Protocol):
    model_name: str
    max_horizon: int

    def info(self) -> dict[str, Any]: ...

    async def forecast(self, req: dict[str, Any]) -> dict[str, Any]: ...

    async def backtest(
        self, chunks: list[list[dict[str, Any]]], horizon: int, folds: int, space: str
    ) -> list[dict[str, Any]]: ...


class DeciderBackend(Protocol):
    def info(self) -> dict[str, Any]: ...

    async def decide(self, req: dict[str, Any]) -> dict[str, Any]: ...

    async def systemone(self, requests: list[dict[str, Any]]) -> list[dict[str, Any]]: ...


class LocalForecaster:
    """In-process TimesFM; blocking torch work runs in a worker thread."""

    def __init__(self, runtime: TimesFMRuntime) -> None:
        self.runtime = runtime
        self.model_name = runtime.cfg.checkpoint
        self.max_horizon = runtime.cfg.max_horizon

    def info(self) -> dict[str, Any]:
        return {"enabled": True, **self.runtime.info()}

    async def forecast(self, req: dict[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(self.runtime.forecast, req)

    async def backtest(self, chunks: list[list[dict[str, Any]]], horizon: int, folds: int, space: str) -> list[dict[str, Any]]:
        flat = [s for chunk in chunks for s in chunk]  # one process: a single batched pass is fastest
        return await asyncio.to_thread(self.runtime.backtest, flat, horizon, folds, space)


class LocalDecider:
    def __init__(self, runtime: LayaRuntime) -> None:
        self.runtime = runtime

    def info(self) -> dict[str, Any]:
        return {"enabled": True, **self.runtime.info()}

    async def decide(self, req: dict[str, Any]) -> dict[str, Any]:
        return await asyncio.to_thread(self.runtime.decide, req)

    async def systemone(self, requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self.runtime.systemone, requests)


# ───────────────────────────── HTTP app ─────────────────────────────


def create_app(
    forecaster: ForecasterBackend | None,
    decider: DeciderBackend | None,
    *,
    token: str | Callable[[], str | None] | None = None,
    allow_no_auth: bool = False,
    deployment: str = "local",
    backtest_chunk: int | None = None,
) -> Any:
    """Build the FastAPI app. ``None`` backends answer 501 on their routes.

    Auth: every POST needs ``Authorization: Bearer <token>`` where the token defaults to
    env MIDAS_MODAL_TOKEN (read per request). With no token configured every POST is
    rejected unless ``allow_no_auth`` (fail closed). GET /health is public.
    """
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    chunk_size = backtest_chunk or env_int("MIDAS_INTEL_BACKTEST_CHUNK", 8)
    app = FastAPI(title="midas-intel", version="1.0.0", docs_url=None, redoc_url=None, openapi_url=None)

    def expected_token() -> str | None:
        if callable(token):
            return token()
        return token if token is not None else os.environ.get("MIDAS_MODAL_TOKEN")

    def authorized(request: Request) -> bool:
        expected = expected_token()
        if not expected:
            return allow_no_auth
        return cm.check_bearer(request.headers.get("authorization"), expected)

    def error(status: int, detail: str) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if status == 401 else None
        return JSONResponse({"error": detail}, status_code=status, headers=headers)

    async def read_json(request: Request, cap: int) -> Any:
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > cap:
            raise cm.ValidationError("request body too large", status=413)
        size, chunks = 0, []
        async for part in request.stream():  # enforce the cap for chunked bodies too
            size += len(part)
            if size > cap:
                raise cm.ValidationError("request body too large", status=413)
            chunks.append(part)
        try:
            return json.loads(b"".join(chunks))
        except ValueError:
            raise cm.ValidationError("request body must be valid JSON") from None

    async def handle(request: Request, handler: Callable[[Any], Any], cap: int = MAX_BODY_BYTES) -> JSONResponse:
        if not authorized(request):
            return error(401, "invalid or missing bearer token")
        try:
            return JSONResponse(await handler(await read_json(request, cap)))
        except cm.ValidationError as e:
            return error(e.status, str(e))
        except ServiceError as e:
            return error(e.status, e.detail)
        except Exception:  # never leak internals
            log.exception("unhandled error on %s", request.url.path)
            return error(500, "internal error")

    def need_forecaster() -> ForecasterBackend:
        if forecaster is None:
            raise ServiceError(501, "timesfm is not enabled on this server")
        return forecaster

    def need_decider() -> DeciderBackend:
        if decider is None:
            raise ServiceError(501, "laya is not enabled on this server")
        return decider

    @app.get("/health")
    async def health() -> dict[str, Any]:
        models = {
            "timesfm": forecaster.info() if forecaster else {"enabled": False},
            "laya": decider.info() if decider else {"enabled": False},
        }
        ok = not any(m.get("error") for m in models.values())
        return {"ok": ok, "deployment": deployment, "fallback": cm.RW_MODEL, "models": models}

    async def do_forecast(body: Any) -> dict[str, Any]:
        f = need_forecaster()
        req = cm.validate_forecast_request(body, max_horizon=f.max_horizon)
        if not cm.needs_model(req):  # every series < MIN_CONTEXT: no GPU round-trip
            return cm.fallback_forecasts(req)
        return await f.forecast(req)

    async def do_backtest(body: Any) -> dict[str, Any]:
        f = need_forecaster()
        req = cm.validate_backtest_request(body, max_horizon=f.max_horizon)
        per = await f.backtest(cm.chunked(req["series"], chunk_size), req["horizon"], req["folds"], req["space"])
        return {
            "model": f.model_name,
            "baseline": cm.RW_MODEL if req["space"] == "logit" else cm.RAW_RW_MODEL,
            "horizon": req["horizon"],
            "folds": req["folds"],
            "space": req["space"],
            "per_series": per,
            "aggregate": cm.aggregate_backtest(per),
        }

    async def do_decide(body: Any) -> dict[str, Any]:
        d = need_decider()
        return await d.decide(cm.validate_decide_request(body))

    async def do_systemone(body: Any) -> dict[str, Any]:
        d = need_decider()
        (result,) = await d.systemone([cm.validate_systemone_request(body)])
        return result

    async def do_systemone_batch(body: Any) -> dict[str, Any]:
        d = need_decider()
        return {"responses": await d.systemone(cm.validate_systemone_batch(body))}

    @app.post("/forecast")
    async def forecast_route(request: Request) -> JSONResponse:
        return await handle(request, do_forecast)

    @app.post("/backtest")
    async def backtest_route(request: Request) -> JSONResponse:
        return await handle(request, do_backtest)

    @app.post("/decide")
    async def decide_route(request: Request) -> JSONResponse:
        return await handle(request, do_decide)

    @app.post("/v1/systemone")
    async def systemone_route(request: Request) -> JSONResponse:
        return await handle(request, do_systemone, MAX_SYSTEMONE_BODY_BYTES)

    @app.post("/v1/systemone/batch")
    async def systemone_batch_route(request: Request) -> JSONResponse:
        return await handle(request, do_systemone_batch)

    return app

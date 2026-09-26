"""Modal app ``midas-intel``: TimesFM forecasts + Laya decisions over HTTPS.

    modal deploy modal/midas_intel.py      # prints the API URL -> engine env MIDAS_MODAL_URL
    modal run modal/midas_intel.py         # smoke test: one forecast + one decision on GPU

Thin wrapper: the models and routes live in intel_app.py / core_math.py (no modal imports)
so the same FastAPI app also runs locally via serve_local.py. Layout on Modal:

  api                 CPU, @modal.asgi_app  -> FastAPI (auth, validation, fallbacks)
  TimesFMForecaster   GPU L4                -> forecast() / backtest() (fan-out with .map)
  LayaDecider         GPU T4 (or CPU)       -> decide() / systemone()

Verified against modal 1.5.5: App.cls(gpu, image, volumes, secrets, env, memory, timeout,
startup_timeout, scaledown_window, min/max_containers), App.function, modal.enter/method/
asgi_app/concurrent, Image.debian_slim(python_version).uv_pip_install(..., index_url=)
.env().add_local_python_source(), Volume.from_name(create_if_missing=True).commit(),
Secret.from_name(required_keys=), Function.remote.aio / .map.aio(kwargs=).
"""

import logging
import math
import os
from typing import Any

import modal

import core_math as cm
import intel_app as ia

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("midas.intel.modal")

APP_NAME = "midas-intel"
app = modal.App(APP_NAME)


def _gpu(value: str) -> str | None:
    """'' / 'cpu' / 'none' -> no GPU (Laya then runs on CPU; TimesFM too, slowly)."""
    v = value.strip()
    return None if v.lower() in ("", "cpu", "none") else v


# Deploy-time knobs. They are forwarded into every container (env=) so the module
# re-imported inside a container sees the same values the deploy did.
MODAL_ENV_VARS = (
    "MIDAS_TIMESFM_GPU", "MIDAS_LAYA_GPU", "MIDAS_INTEL_SCALEDOWN",
    "MIDAS_TIMESFM_MIN_CONTAINERS", "MIDAS_TIMESFM_MAX_CONTAINERS",
    "MIDAS_LAYA_MIN_CONTAINERS", "MIDAS_LAYA_MAX_CONTAINERS",
)  # fmt: skip
FORWARDED_ENV = {k: os.environ[k] for k in (*ia.CONFIG_ENV_VARS, *MODAL_ENV_VARS) if os.environ.get(k)}
TIMESFM_GPU = _gpu(os.environ.get("MIDAS_TIMESFM_GPU", "L4"))
LAYA_GPU = _gpu(os.environ.get("MIDAS_LAYA_GPU", "T4"))
SCALEDOWN = ia.env_int("MIDAS_INTEL_SCALEDOWN", 300)  # idle seconds a GPU container stays warm (billed)
TIMESFM_MIN_CONTAINERS = ia.env_int("MIDAS_TIMESFM_MIN_CONTAINERS", 0)  # 1 = no cold starts, always billed
TIMESFM_MAX_CONTAINERS = ia.env_int("MIDAS_TIMESFM_MAX_CONTAINERS", 4)  # caps backtest fan-out cost
LAYA_MIN_CONTAINERS = ia.env_int("MIDAS_LAYA_MIN_CONTAINERS", 0)
LAYA_MAX_CONTAINERS = ia.env_int("MIDAS_LAYA_MAX_CONTAINERS", 2)
TIMESFM_CFG = ia.TimesFMConfig.from_env()

HF_CACHE = "/cache"
hf_cache = modal.Volume.from_name("midas-hf-cache", create_if_missing=True)
# MIDAS_MODAL_TOKEN guards the API; an optional HF_TOKEN in the same secret lifts HF rate limits.
secret = modal.Secret.from_name("midas-intel", required_keys=["MIDAS_MODAL_TOKEN"])

LOCAL_MODULES = ("core_math", "intel_app")  # must be the last image step (mounted at startup)

# torch 2.14 on PyPI bundles CUDA 13 (needs a >= 580 driver); the cu126 build runs on any
# driver Modal ships. timesfm / laya then keep this torch since it satisfies torch>=2.0.
gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install("torch==2.14.0", index_url="https://download.pytorch.org/whl/cu126")
    .uv_pip_install("timesfm[torch]==3.0.2", "laya==0.3.20", "numpy>=1.26")
    .env({"HF_HOME": HF_CACHE, "HF_HUB_DISABLE_PROGRESS_BARS": "1", "TOKENIZERS_PARALLELISM": "false"})
    .add_local_python_source(*LOCAL_MODULES)
)
web_image = (
    modal.Image.debian_slim(python_version="3.11")
    .uv_pip_install("fastapi>=0.115", "numpy>=1.26")
    .add_local_python_source(*LOCAL_MODULES)
)


def _load_and_persist(runtime: ia.TimesFMRuntime | ia.LayaRuntime) -> None:
    """Load once per container; keep failures for /health instead of crash-looping."""
    try:
        runtime.load()
    except ia.ServiceError as e:
        log.error("model load failed (%s): %s", e.status, e.detail)
    try:
        hf_cache.commit()  # persist freshly downloaded weights for the next cold start
    except Exception:
        log.exception("hf cache commit failed")


@app.cls(
    image=gpu_image,
    gpu=TIMESFM_GPU,
    volumes={HF_CACHE: hf_cache},
    secrets=[secret],
    env=FORWARDED_ENV or None,
    memory=4096,
    timeout=600,
    startup_timeout=1200,  # first container downloads ~0.9 GB of weights
    scaledown_window=SCALEDOWN,
    min_containers=TIMESFM_MIN_CONTAINERS,
    max_containers=TIMESFM_MAX_CONTAINERS,
)
class TimesFMForecaster:
    @modal.enter()
    def load(self) -> None:
        self.runtime = ia.TimesFMRuntime(TIMESFM_CFG)
        _load_and_persist(self.runtime)

    @modal.method()
    def forecast(self, req: dict) -> dict:
        return ia.call_enveloped(self.runtime.forecast, req)

    @modal.method()
    def backtest(self, series: list[dict], horizon: int, folds: int, space: str = "logit") -> Any:
        return ia.call_enveloped(self.runtime.backtest, series, horizon, folds, space)


@app.cls(
    image=gpu_image,
    gpu=LAYA_GPU,
    volumes={HF_CACHE: hf_cache},
    secrets=[secret],
    env=FORWARDED_ENV or None,
    memory=8192,  # three checkpoints (~1.16B params) also fit in RAM for the CPU fallback
    timeout=600,
    startup_timeout=1200,  # first container downloads ~4.7 GB of weights
    scaledown_window=SCALEDOWN,
    min_containers=LAYA_MIN_CONTAINERS,
    max_containers=LAYA_MAX_CONTAINERS,
)
class LayaDecider:
    @modal.enter()
    def load(self) -> None:
        self.runtime = ia.LayaRuntime()  # Router(preload=True); CPU if no CUDA
        _load_and_persist(self.runtime)

    @modal.method()
    def decide(self, req: dict) -> dict:
        return ia.call_enveloped(self.runtime.decide, req)

    @modal.method()
    def systemone(self, requests: list[dict]) -> Any:
        return ia.call_enveloped(self.runtime.systemone, requests)


class ModalForecaster:
    """ForecasterBackend that reaches the GPU class over Modal RPC."""

    model_name = TIMESFM_CFG.checkpoint
    max_horizon = TIMESFM_CFG.max_horizon

    def info(self) -> dict[str, Any]:
        # Static: probing the GPU class would wake (and bill) a container on every health check.
        return {
            "enabled": True,
            "checkpoint": TIMESFM_CFG.checkpoint,
            "family": TIMESFM_CFG.family,
            "gpu": TIMESFM_GPU or "cpu",
            "max_context": TIMESFM_CFG.max_context,
            "max_horizon": TIMESFM_CFG.max_horizon,
        }

    async def forecast(self, req: dict[str, Any]) -> dict[str, Any]:
        return ia.unwrap(await TimesFMForecaster().forecast.remote.aio(req))

    async def backtest(self, chunks: list[list[dict[str, Any]]], horizon: int, folds: int, space: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        kwargs = {"horizon": horizon, "folds": folds, "space": space}
        async for part in TimesFMForecaster().backtest.map.aio(chunks, kwargs=kwargs):  # ordered fan-out
            out.extend(ia.unwrap(part))
        return out


class ModalDecider:
    def info(self) -> dict[str, Any]:
        return {"enabled": True, "checkpoints": sorted(cm.LAYA_CHECKPOINTS.values()), "gpu": LAYA_GPU or "cpu"}

    async def decide(self, req: dict[str, Any]) -> dict[str, Any]:
        return ia.unwrap(await LayaDecider().decide.remote.aio(req))

    async def systemone(self, requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return ia.unwrap(await LayaDecider().systemone.remote.aio(requests))


@app.function(image=web_image, secrets=[secret], env=FORWARDED_ENV or None, scaledown_window=300, timeout=900)
@modal.concurrent(max_inputs=64)
@modal.asgi_app()
def api() -> Any:
    return ia.create_app(ModalForecaster(), ModalDecider(), deployment="modal")


@app.local_entrypoint()
def smoke() -> None:
    """`modal run modal/midas_intel.py`: exercise both GPU classes once."""
    values = [0.5 + 0.2 * math.sin(i / 9) for i in range(256)]
    fc = TimesFMForecaster().forecast.remote({"series": [{"id": "demo", "values": values}], "horizon": 8})
    print("forecast:", fc)
    dec = LayaDecider().decide.remote({
        "items": [{
            "state": "Market: Will the Fed cut rates in October? News: the Fed chair signals a cut next meeting.",
            "questions": {
                "direction": {"type": "choice", "instructions": "Which way does this move YES?",
                              "criteria": {"up": "raises YES", "down": "lowers YES", "none": "no effect"}},
                "resolves": {"type": "noul", "instructions": "Does this news resolve the market?"},
            },
        }]
    })
    print("decide:", dec)

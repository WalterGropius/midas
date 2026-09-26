"""Pure-numpy helpers for the MIDAS intel service (TimesFM forecasts + Laya decisions).

Deliberately free of modal / torch / fastapi imports: this module is shared by the
Modal wrapper (midas_intel.py), the FastAPI app (intel_app.py) and the unit tests.

Conventions
-----------
* Prices are probabilities in [0, 1] (Polymarket). In ``"logit"`` space they are
  clipped to [PROB_EPS, 1 - PROB_EPS] and mapped with ``logit``; forecasts are made
  there and mapped back with ``sigmoid``. Quantiles survive any monotone transform,
  so sigmoid(q_tau(logit X)) == q_tau(X) exactly; the point forecast is the median.
* Quantile keys are ``q10`` .. ``q90``; only deciles are supported because that is
  what the TimesFM quantile heads emit.
* The fallback forecaster mirrors ``packages/core/src/forecast-local.ts``: a
  driftless random walk in log-odds with EWMA(0.94) volatility.
"""

from __future__ import annotations

import hmac
import json
import math
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any, TypeVar

import numpy as np

# ───────────────────────────── constants ─────────────────────────────

PROB_EPS = 1e-3
Z90 = 1.2815515655446004  # standard-normal 0.9 quantile
_Z_LOWER = {0.1: -Z90, 0.2: -0.8416212335729143, 0.3: -0.5244005127080407, 0.4: -0.2533471031357997}
# z-score per decile: symmetric around the median
DECILE_Z: dict[float, float] = {**_Z_LOWER, 0.5: 0.0, **{round(1.0 - q, 1): -z for q, z in _Z_LOWER.items()}}
DECILES: tuple[float, ...] = tuple(sorted(DECILE_Z))  # (0.1, ..., 0.9)
REQUIRED_QUANTILES: tuple[float, ...] = (0.1, 0.5, 0.9)  # always present in responses

EWMA_LAMBDA = 0.94
MIN_VOL = 0.005  # per-step vol floor (model-space units)
DEFAULT_VOL = 0.05  # vol used when there are < 2 increments
EWMA_WINDOW = 1000  # 0.94**1000 ~ 1e-27: older increments carry no weight
MIN_CONTEXT = 16  # below this TimesFM is skipped for the random-walk fallback

SPACES = ("logit", "raw")
RW_MODEL = "logit-random-walk"
RAW_RW_MODEL = "raw-random-walk"

# Request guardrails (bodies are untrusted, even behind the bearer token).
MAX_SERIES = 1024
MAX_SERIES_POINTS = 100_000
MAX_HORIZON = 256
MAX_FOLDS = 50
MAX_ID_CHARS = 256
MAX_DECIDE_ITEMS = 512
MAX_QUESTIONS = 64  # same caps as laya.serve
MAX_STATE_CHARS = 50_000

# Laya checkpoints: Router key -> public checkpoint name (used as the "model" field).
LAYA_CHECKPOINTS: dict[str, str] = {
    "english": "laya",
    "multilingual": "laya-multilingual",
    "typed-decisions": "laya-typed-decisions",
}
DECIDE_MODELS = ("auto", *LAYA_CHECKPOINTS)
# Mirrors laya 0.3.20 router._ALIASES and serve._PUBLISHED_MODEL_IDS.
LAYA_ALIASES: dict[str, str] = {
    "en": "english", "laya": "english", "default": "english",
    "multi": "multilingual", "ml": "multilingual", "laya-multilingual": "multilingual",
    "typed": "typed-decisions", "typed_decisions": "typed-decisions",
    "laya-typed-decisions": "typed-decisions", "decisions": "typed-decisions",
    "convaiinnovations/laya-multilingual": "multilingual",
    "convaiinnovations/laya-typed-decisions": "typed-decisions",
}
QUESTION_TYPES = ("choice", "score", "noul")

T = TypeVar("T")


class ValidationError(ValueError):
    """A client error in a request payload; ``status`` is the HTTP code to return."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


# ───────────────────────────── transforms ─────────────────────────────


def clip_prob(p: Any, eps: float = PROB_EPS) -> np.ndarray:
    return np.clip(np.asarray(p, dtype=np.float64), eps, 1.0 - eps)


def logit(p: Any, eps: float = PROB_EPS) -> np.ndarray:
    q = clip_prob(p, eps)
    return np.log(q) - np.log1p(-q)


def sigmoid(x: Any) -> np.ndarray:
    """Overflow-free logistic function."""
    x = np.asarray(x, dtype=np.float64)
    z = np.exp(-np.abs(x))
    return np.where(x >= 0, 1.0 / (1.0 + z), z / (1.0 + z))


def to_model_space(values: Any, space: str) -> np.ndarray:
    return logit(values) if space == "logit" else np.asarray(values, dtype=np.float64)


def from_model_space(x: Any, space: str) -> np.ndarray:
    return sigmoid(x) if space == "logit" else np.asarray(x, dtype=np.float64)


def prepare_context(values: Sequence[float], space: str, max_context: int) -> np.ndarray:
    """Most recent ``max_context`` points, in model space, as float32 for torch.

    Shorter series are left-padded (with a mask) by the model itself.
    """
    tail = np.asarray(values, dtype=np.float64)[-max_context:]
    return to_model_space(tail, space).astype(np.float32)


def quantile_key(q: float) -> str:
    return f"q{int(round(q * 100))}"


def _rounded(x: np.ndarray) -> list[float]:
    return [float(v) for v in np.round(np.asarray(x, dtype=np.float64), 6)]


def _wanted_quantiles(quantiles: Iterable[float]) -> list[float]:
    return sorted({round(float(q), 1) for q in quantiles} | set(REQUIRED_QUANTILES))


# ───────────────────────────── fallback forecaster ─────────────────────────────


def ewma_vol(increments: Any, lam: float = EWMA_LAMBDA) -> float:
    """EWMA std of increments, seeded with the first squared increment (as the TS engine)."""
    r = np.asarray(increments, dtype=np.float64)[-EWMA_WINDOW:]
    if r.size < 2:
        return DEFAULT_VOL
    v = float(r[0] ** 2)
    for x in r[1:]:
        v = lam * v + (1.0 - lam) * float(x) * float(x)
    return max(MIN_VOL, math.sqrt(v))


def ewma_logit_vol(values: Any, lam: float = EWMA_LAMBDA) -> float:
    return ewma_vol(np.diff(logit(values)), lam)


def random_walk_forecast(
    values: Sequence[float],
    horizon: int,
    quantiles: Iterable[float] = REQUIRED_QUANTILES,
    space: str = "logit",
) -> dict[str, Any]:
    """Driftless random walk in model space: q_tau(h) = last + z_tau * sigma * sqrt(h)."""
    x = to_model_space(values, space)
    if x.size == 0:
        raise ValidationError("cannot forecast an empty series")
    sigma = ewma_vol(np.diff(x))
    spread = sigma * np.sqrt(np.arange(1, horizon + 1, dtype=np.float64))
    last = float(x[-1])
    out: dict[str, Any] = {"point": _rounded(from_model_space(np.full(horizon, last), space))}
    for q in _wanted_quantiles(quantiles):
        out[quantile_key(q)] = _rounded(from_model_space(last + DECILE_Z[q] * spread, space))
    out["model"] = RW_MODEL if space == "logit" else RAW_RW_MODEL
    return out


def decode_deciles(
    point: Any,
    deciles: Any,
    space: str,
    quantiles: Iterable[float] = REQUIRED_QUANTILES,
    nonneg: bool = False,
) -> dict[str, list[float]]:
    """Map a model's (h,) median and (h, 9) q10..q90 deciles back to the response space.

    Deciles are sorted per step (repairs any quantile crossing); ``nonneg`` clamps at 0
    (used for raw-space series that were non-negative, since the model is compiled
    with infer_is_positive=False so logit inputs are never clamped).
    """
    p = np.asarray(point, dtype=np.float64)
    d = np.sort(np.asarray(deciles, dtype=np.float64), axis=-1)
    if p.ndim != 1 or d.shape != (p.shape[0], len(DECILES)):
        raise ValueError(f"expected point (h,) and deciles (h, 9); got {p.shape} and {d.shape}")
    if nonneg:
        p, d = np.maximum(p, 0.0), np.maximum(d, 0.0)
    out = {"point": _rounded(from_model_space(p, space))}
    for q in _wanted_quantiles(quantiles):
        out[quantile_key(q)] = _rounded(from_model_space(d[:, DECILES.index(q)], space))
    return out


def fallback_forecasts(req: Mapping[str, Any]) -> dict[str, Any]:
    """Random-walk forecasts for every series of a validated forecast request."""
    return {
        "forecasts": [
            {"id": s["id"], **random_walk_forecast(s["values"], req["horizon"], req["quantiles"], req["space"])}
            for s in req["series"]
        ]
    }


def needs_model(req: Mapping[str, Any], min_context: int = MIN_CONTEXT) -> bool:
    """True when at least one series is long enough for TimesFM."""
    return any(len(s["values"]) >= min_context for s in req["series"])


# ───────────────────────────── scoring & backtest ─────────────────────────────


def pinball_loss(y: Any, q: Any, tau: float) -> np.ndarray:
    """Elementwise quantile (pinball) loss; lower is better, 0 when q == y."""
    d = np.asarray(y, dtype=np.float64) - np.asarray(q, dtype=np.float64)
    return np.maximum(tau * d, (tau - 1.0) * d)


def mean_pinball(y: Any, forecast: Mapping[str, Sequence[float]], taus: Sequence[float] = REQUIRED_QUANTILES) -> float:
    """Pinball loss averaged over taus and horizon steps."""
    return float(np.mean([pinball_loss(y, forecast[quantile_key(t)], t).mean() for t in taus]))


def coverage(y: Any, lo: Any, hi: Any) -> float:
    y = np.asarray(y, dtype=np.float64)
    return float(np.mean((y >= np.asarray(lo)) & (y <= np.asarray(hi))))


def skill_score(model_loss: float | None, baseline_loss: float | None) -> float | None:
    """1 - model/baseline; None when undefined."""
    if model_loss is None or baseline_loss is None or baseline_loss <= 0:
        return None
    return 1.0 - model_loss / baseline_loss


def rolling_origin_splits(n: int, horizon: int, folds: int, min_context: int = MIN_CONTEXT) -> list[int]:
    """Cutoffs for rolling-origin evaluation, oldest first.

    Fold k (k = 1 is the most recent) trains on ``values[:n - k*horizon]`` and scores the
    next ``horizon`` points, so test windows never overlap. Folds whose context would be
    shorter than ``min_context`` are dropped.
    """
    if n < 0 or horizon < 1 or folds < 1:
        raise ValueError("need n >= 0, horizon >= 1, folds >= 1")
    return [c for c in (n - k * horizon for k in range(folds, 0, -1)) if c >= min_context]


ForecastFn = Callable[[list[np.ndarray], int], Sequence[Mapping[str, Sequence[float]]]]


def backtest_series(
    series: Sequence[Mapping[str, Any]],
    horizon: int,
    folds: int,
    forecast_fn: ForecastFn,
    space: str = "logit",
    min_context: int = MIN_CONTEXT,
) -> list[dict[str, Any]]:
    """Rolling-origin backtest of ``forecast_fn`` vs the random walk, per series.

    ``forecast_fn(contexts, horizon)`` receives every (series, fold) context at once (so a
    model can batch them) in the original space and must return, per context, a mapping
    with ``q10``/``q50``/``q90`` in that same space. Losses are in the original space.
    """
    jobs: list[tuple[int, int]] = []
    contexts: list[np.ndarray] = []
    arrays = [np.asarray(s["values"], dtype=np.float64) for s in series]
    for i, v in enumerate(arrays):
        for cut in rolling_origin_splits(len(v), horizon, folds, min_context):
            jobs.append((i, cut))
            contexts.append(v[:cut])
    forecasts = list(forecast_fn(contexts, horizon)) if contexts else []
    if len(forecasts) != len(contexts):
        raise RuntimeError(f"forecast_fn returned {len(forecasts)} forecasts for {len(contexts)} contexts")

    acc: list[dict[str, list[float]]] = [{"m": [], "rw": [], "cm": [], "crw": []} for _ in series]
    for (i, cut), ctx, fc in zip(jobs, contexts, forecasts):
        y = arrays[i][cut : cut + horizon]
        rw = random_walk_forecast(ctx, horizon, space=space)
        acc[i]["m"].append(mean_pinball(y, fc))
        acc[i]["rw"].append(mean_pinball(y, rw))
        acc[i]["cm"].append(coverage(y, fc["q10"], fc["q90"]))
        acc[i]["crw"].append(coverage(y, rw["q10"], rw["q90"]))

    out: list[dict[str, Any]] = []
    for s, a in zip(series, acc):
        k = len(a["m"])
        tfm = float(np.mean(a["m"])) if k else None
        rwl = float(np.mean(a["rw"])) if k else None
        out.append({
            "id": s["id"],
            "folds": k,
            "timesfm_pinball": tfm,
            "rw_pinball": rwl,
            "skill": skill_score(tfm, rwl),
            "coverage80": {
                "timesfm": float(np.mean(a["cm"])) if k else None,
                "rw": float(np.mean(a["crw"])) if k else None,
            },
        })
    return out


def aggregate_backtest(per_series: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Fold-weighted mean of per-series metrics (series without folds are skipped)."""
    used = [r for r in per_series if r.get("folds")]
    total = sum(int(r["folds"]) for r in used)

    def wmean(get: Callable[[Mapping[str, Any]], float]) -> float | None:
        return sum(get(r) * r["folds"] for r in used) / total if total else None

    tfm = wmean(lambda r: r["timesfm_pinball"])
    rwl = wmean(lambda r: r["rw_pinball"])
    return {
        "series": len(used),
        "folds": total,
        "timesfm_pinball": tfm,
        "rw_pinball": rwl,
        "skill": skill_score(tfm, rwl),
        "coverage80": {
            "timesfm": wmean(lambda r: r["coverage80"]["timesfm"]),
            "rw": wmean(lambda r: r["coverage80"]["rw"]),
        },
    }


def chunked(items: Sequence[T], size: int) -> list[list[T]]:
    if size < 1:
        raise ValueError("chunk size must be >= 1")
    return [list(items[i : i + size]) for i in range(0, len(items), size)]


# ───────────────────────────── request validation ─────────────────────────────


def _mapping(x: Any, what: str) -> Mapping[str, Any]:
    if not isinstance(x, Mapping):
        raise ValidationError(f"{what} must be a JSON object")
    return x


def _int(x: Any, name: str, lo: int, hi: int) -> int:
    if type(x) is not int:  # rejects bool and float
        raise ValidationError(f"'{name}' must be an integer")
    if not lo <= x <= hi:
        raise ValidationError(f"'{name}' must be in [{lo}, {hi}], got {x}")
    return x


def _space(body: Mapping[str, Any]) -> str:
    space = body.get("space", "logit")
    if space not in SPACES:
        raise ValidationError(f"'space' must be one of {list(SPACES)}")
    return space


def _series_list(body: Mapping[str, Any], space: str, max_series: int) -> list[dict[str, Any]]:
    raw = body.get("series")
    if not isinstance(raw, list) or not raw:
        raise ValidationError("'series' must be a non-empty array")
    if len(raw) > max_series:
        raise ValidationError(f"too many series ({len(raw)} > {max_series})", status=413)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for i, s in enumerate(raw):
        s = _mapping(s, f"series[{i}]")
        sid = s.get("id")
        if not isinstance(sid, str) or not sid or len(sid) > MAX_ID_CHARS:
            raise ValidationError(f"series[{i}].id must be a non-empty string (<= {MAX_ID_CHARS} chars)")
        if sid in seen:
            raise ValidationError(f"duplicate series id {sid!r}")
        seen.add(sid)
        vals = s.get("values")
        if not isinstance(vals, list) or not vals:
            raise ValidationError(f"series[{i}].values must be a non-empty array of numbers")
        if len(vals) > MAX_SERIES_POINTS:
            raise ValidationError(f"series[{i}] has too many points (> {MAX_SERIES_POINTS})", status=413)
        if not all(type(v) in (int, float) for v in vals):
            raise ValidationError(f"series[{i}].values must contain only numbers")
        arr = np.asarray(vals, dtype=np.float64)
        if not np.all(np.isfinite(arr)):
            raise ValidationError(f"series[{i}].values must be finite")
        if space == "logit" and (arr.min() < 0.0 or arr.max() > 1.0):
            raise ValidationError(f"series[{i}].values must be probabilities in [0, 1] when space='logit'")
        step = s.get("step_sec")
        if step is not None:
            step = _int(step, f"series[{i}].step_sec", 1, 10**9)
        out.append({"id": sid, "values": [float(v) for v in arr], "step_sec": step})
    return out


def validate_forecast_request(
    body: Any, *, max_horizon: int = MAX_HORIZON, max_series: int = MAX_SERIES
) -> dict[str, Any]:
    """Validate and normalise a POST /forecast body (idempotent on its own output)."""
    body = _mapping(body, "request body")
    space = _space(body)
    horizon = _int(body.get("horizon"), "horizon", 1, max_horizon)
    qs = body.get("quantiles", list(REQUIRED_QUANTILES))
    if not isinstance(qs, list) or not all(type(q) in (int, float) for q in qs):
        raise ValidationError("'quantiles' must be an array of numbers")
    rounded = [round(float(q), 1) for q in qs]
    if any(abs(r - float(q)) > 1e-9 or r not in DECILE_Z for r, q in zip(rounded, qs)):
        raise ValidationError(f"'quantiles' must be deciles from {list(DECILES)}")
    return {
        "series": _series_list(body, space, max_series),
        "horizon": horizon,
        "quantiles": _wanted_quantiles(rounded),
        "space": space,
    }


def validate_backtest_request(
    body: Any, *, max_horizon: int = MAX_HORIZON, max_series: int = MAX_SERIES, max_folds: int = MAX_FOLDS
) -> dict[str, Any]:
    """Validate and normalise a POST /backtest body."""
    body = _mapping(body, "request body")
    space = _space(body)
    return {
        "series": _series_list(body, space, max_series),
        "horizon": _int(body.get("horizon"), "horizon", 1, max_horizon),
        "folds": _int(body.get("folds", 5), "folds", 1, max_folds),
        "space": space,
    }


def validate_state(state: Any, where: str = "state") -> Any:
    if not isinstance(state, (str, dict, list)):
        raise ValidationError(f"'{where}' must be a string, object or array")
    size = len(state) if isinstance(state, str) else len(json.dumps(state, ensure_ascii=False))
    if size > MAX_STATE_CHARS:
        raise ValidationError(f"'{where}' too large ({size} > {MAX_STATE_CHARS} chars)", status=413)
    return state


def validate_questions(questions: Any, *, where: str = "questions", status: int = 400) -> dict[str, Any]:
    """Mirror of laya 0.3.20 ``Agent._check_question`` so bad schemas fail before the GPU."""
    if not isinstance(questions, Mapping) or not questions:
        raise ValidationError(f"'{where}' must be a non-empty object")
    if len(questions) > MAX_QUESTIONS:
        raise ValidationError(f"too many questions ({len(questions)} > {MAX_QUESTIONS})", status=413)
    for qid, q in questions.items():
        if not isinstance(q, Mapping):
            raise ValidationError(f"question {qid!r}: definition must be an object", status)
        t = q.get("type")
        if t not in QUESTION_TYPES:
            raise ValidationError(f"question {qid!r}: type must be one of {list(QUESTION_TYPES)}", status)
        ins = q.get("instructions")
        if not isinstance(ins, str) or not ins.strip():
            raise ValidationError(f"question {qid!r}: 'instructions' must be a non-empty string", status)
        crit = q.get("criteria")
        if t == "choice":
            if not isinstance(crit, (Mapping, list)) or not crit:
                raise ValidationError(f"question {qid!r}: choice needs non-empty 'criteria' (object or array)", status)
        elif t == "score":
            if not isinstance(crit, list) or not crit:
                raise ValidationError(f"question {qid!r}: score needs 'criteria' as a non-empty array of levels", status)
        elif crit is not None:
            if not isinstance(crit, Mapping) or not {str(k).lower() for k in crit} <= {"true", "false"}:
                raise ValidationError(f"question {qid!r}: noul 'criteria' may only have keys 'true'/'false'", status)
        if "labels" in q:
            labels = q["labels"]
            ok = (
                t == "noul"
                and isinstance(labels, Mapping)
                and set(labels) == {"false", "true"}
                and all(isinstance(v, str) and v.strip() for v in labels.values())
                and labels["false"].strip() != labels["true"].strip()
            )
            if not ok:
                raise ValidationError(
                    f"question {qid!r}: 'labels' is noul-only and must map 'false'/'true' to distinct strings", status
                )
    return dict(questions)


def resolve_laya_model(name: Any) -> str | None:
    """Map a client ``model`` string to a Router key, or None to auto-route.

    Unknown ids (e.g. Jev's "jev-latest") and the root bundle "convaiinnovations/laya"
    auto-route, exactly like ``laya.serve._resolve_model``.
    """
    if name is None:
        return None
    key = str(name).strip().lower()
    key = LAYA_ALIASES.get(key, key)
    return key if key in LAYA_CHECKPOINTS else None


def validate_decide_request(body: Any, *, max_items: int = MAX_DECIDE_ITEMS) -> dict[str, Any]:
    """Validate a POST /decide body -> {"items": [{state, questions}], "model": str|None}."""
    body = _mapping(body, "request body")
    items = body.get("items")
    if not isinstance(items, list) or not items:
        raise ValidationError("'items' must be a non-empty array")
    if len(items) > max_items:
        raise ValidationError(f"too many items ({len(items)} > {max_items})", status=413)
    model = body.get("model") or "auto"  # None == "auto" keeps this idempotent on its own output
    if model not in DECIDE_MODELS:
        raise ValidationError(f"'model' must be one of {list(DECIDE_MODELS)}")
    out = []
    for i, it in enumerate(items):
        it = _mapping(it, f"items[{i}]")
        out.append({
            "state": validate_state(it.get("state"), f"items[{i}].state"),
            "questions": validate_questions(it.get("questions"), where=f"items[{i}].questions"),
        })
    return {"items": out, "model": resolve_laya_model(model)}


def validate_systemone_request(body: Any, where: str = "request body") -> dict[str, Any]:
    """Validate a Jev ``/v1/systemone`` request -> {state, questions, model: key|None}.

    Status codes follow laya.serve: 400 bad shape, 413 too large, 422 bad question.
    """
    body = _mapping(body, where)
    if "questions" not in body:
        raise ValidationError(f"{where} must have a 'questions' field")
    return {
        "state": validate_state(body.get("state")),
        "questions": validate_questions(body["questions"], status=422),
        "model": resolve_laya_model(body.get("model")),
    }


def validate_systemone_batch(body: Any, *, max_items: int = MAX_DECIDE_ITEMS) -> list[dict[str, Any]]:
    body = _mapping(body, "request body")
    reqs = body.get("requests")
    if not isinstance(reqs, list) or not reqs:
        raise ValidationError("'requests' must be a non-empty array")
    if len(reqs) > max_items:
        raise ValidationError(f"too many requests ({len(reqs)} > {max_items})", status=413)
    return [validate_systemone_request(r, f"requests[{i}]") for i, r in enumerate(reqs)]


# ───────────────────────────── Laya result normalisation ─────────────────────────────


def laya_model_name(result: Mapping[str, Any]) -> str:
    """Public checkpoint name from a Router result's ``routing`` block."""
    key = (result.get("routing") or {}).get("model")
    return LAYA_CHECKPOINTS.get(key, f"laya-{key}" if key else "laya")


def normalize_laya_answer(ans: Mapping[str, Any]) -> dict[str, Any]:
    """Laya answer -> MIDAS S1Answer shape.

    ``confidence`` is Laya's ``answer_confidence`` (= max p, the calibrated quantity,
    i.e. P(reported answer)); Laya's own ``confidence`` for choice/score is a normalised
    entropy and is only used if ``answer_confidence`` is missing.
    """
    t = ans.get("type") or next((k for k in QUESTION_TYPES if k in ans), None)
    probs = {str(k): float(v) for k, v in (ans.get("probabilities") or {}).items()}
    out: dict[str, Any] = {}
    if t == "noul":
        p = float(ans["noul"])
        out["noul"] = p
        fallback_conf = max(p, 1.0 - p)
    elif t == "choice":
        out["choice"] = str(ans["choice"])
        out["probs"] = probs
        fallback_conf = max(probs.values()) if probs else 0.0
    elif t == "score":
        out["score"] = float(ans["score"])
        out["probs"] = probs
        fallback_conf = max(probs.values()) if probs else 0.0
    else:
        raise ValueError(f"unrecognised Laya answer: {sorted(ans)}")
    conf = ans.get("answer_confidence", ans.get("confidence"))
    out["confidence"] = float(conf) if conf is not None else float(fallback_conf)
    return out


def normalize_laya_result(result: Mapping[str, Any], latency_ms: float) -> dict[str, Any]:
    return {
        "answers": {k: normalize_laya_answer(a) for k, a in (result.get("answers") or {}).items()},
        "latency_ms": round(float(latency_ms), 3),
        "model": laya_model_name(result),
    }


# ───────────────────────────── auth ─────────────────────────────


def check_bearer(header: str | None, expected: str | None) -> bool:
    """Constant-time ``Authorization: Bearer <token>`` check. Fails closed when unset."""
    if not expected or not header:
        return False
    scheme, _, token = header.strip().partition(" ")
    if scheme.lower() != "bearer":
        return False
    enc = lambda s: s.strip().encode("utf-8", "surrogateescape")  # noqa: E731 (latin-1 safe)
    return hmac.compare_digest(enc(token), enc(expected))

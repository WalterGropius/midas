"""Tests for core_math (pure numpy): run with `python3 -m pytest modal/test_core_math.py -q`."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest

import core_math as cm


# ───────────────────────────── transforms ─────────────────────────────


def test_clip_logit_sigmoid_roundtrip() -> None:
    p = np.array([0.0, 1e-4, 0.001, 0.2, 0.5, 0.8, 0.999, 1.0])
    back = cm.sigmoid(cm.logit(p))
    np.testing.assert_allclose(back, np.clip(p, 1e-3, 1 - 1e-3), atol=1e-12)
    assert cm.logit(0.5) == pytest.approx(0.0)
    assert float(cm.logit(1.0)) == pytest.approx(math.log(0.999 / 0.001))


def test_sigmoid_is_stable_at_extremes() -> None:
    with np.errstate(over="raise", invalid="raise", divide="raise"):  # underflow to 0 is fine
        s = cm.sigmoid(np.array([-1000.0, -50.0, 0.0, 50.0, 1000.0]))
    assert s[0] == 0.0 and s[-1] == 1.0 and s[2] == 0.5
    assert np.all(np.diff(s) >= 0)


def test_quantiles_commute_with_monotone_sigmoid() -> None:
    x = np.random.default_rng(1).normal(0.3, 1.1, 20_001)  # odd n: exact order statistics
    for tau in (0.1, 0.5, 0.9):
        assert cm.sigmoid(np.quantile(x, tau, method="lower")) == pytest.approx(
            np.quantile(cm.sigmoid(x), tau, method="lower"), abs=1e-12
        )


def test_prepare_context_truncates_and_transforms() -> None:
    vals = list(np.linspace(0.1, 0.9, 50))
    ctx = cm.prepare_context(vals, "logit", max_context=32)
    assert ctx.dtype == np.float32 and ctx.shape == (32,)
    np.testing.assert_allclose(ctx, cm.logit(vals[-32:]), rtol=1e-6)
    raw = cm.prepare_context(vals, "raw", max_context=1000)
    np.testing.assert_allclose(raw, vals, rtol=1e-6)


def test_decile_z_table() -> None:
    assert cm.DECILES == (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)
    assert cm.DECILE_Z[0.9] == cm.Z90 == -cm.DECILE_Z[0.1]
    assert all(cm.DECILE_Z[q] == -cm.DECILE_Z[round(1 - q, 1)] for q in cm.DECILES)
    assert [cm.quantile_key(q) for q in (0.1, 0.5, 0.9)] == ["q10", "q50", "q90"]


# ───────────────────────────── fallback forecaster ─────────────────────────────


def test_ewma_vol_matches_ts_engine_semantics() -> None:
    assert cm.ewma_logit_vol([0.5, 0.6]) == cm.DEFAULT_VOL  # < 3 closes -> default
    assert cm.ewma_logit_vol([0.4] * 30) == cm.MIN_VOL  # flat -> floor
    r = [0.1, -0.2, 0.3]
    v = r[0] ** 2
    for x in r[1:]:
        v = 0.94 * v + 0.06 * x * x
    assert cm.ewma_vol(r) == pytest.approx(math.sqrt(v))


def test_random_walk_forecast_shape_and_ordering() -> None:
    vals = list(0.5 + 0.1 * np.sin(np.linspace(0, 6, 40)))
    fc = cm.random_walk_forecast(vals, horizon=12)
    assert fc["model"] == "logit-random-walk"
    for k in ("point", "q10", "q50", "q90"):
        assert len(fc[k]) == 12
    assert fc["point"] == fc["q50"] == [round(vals[-1], 6)] * 12
    q10, q90 = np.array(fc["q10"]), np.array(fc["q90"])
    assert np.all(q10 < fc["q50"][0]) and np.all(q90 > fc["q50"][0])
    assert np.all(np.diff(q90 - q10) > 0)  # widens with horizon
    assert np.all((q10 > 0) & (q90 < 1))


def test_random_walk_is_sqrt_h_in_logit_space() -> None:
    vals = [0.3, 0.32, 0.29, 0.35, 0.31, 0.33]
    fc = cm.random_walk_forecast(vals, horizon=4)
    sigma = cm.ewma_logit_vol(vals)
    l0 = float(cm.logit(vals[-1]))
    for h in range(1, 5):
        assert fc["q90"][h - 1] == pytest.approx(float(cm.sigmoid(l0 + cm.Z90 * sigma * math.sqrt(h))), abs=1e-6)
        assert fc["q10"][h - 1] == pytest.approx(float(cm.sigmoid(l0 - cm.Z90 * sigma * math.sqrt(h))), abs=1e-6)


def test_random_walk_extra_quantiles_and_raw_space() -> None:
    fc = cm.random_walk_forecast([1.0, 2.0, 1.5, 3.0], 3, quantiles=[0.2, 0.8], space="raw")
    assert fc["model"] == "raw-random-walk"
    assert set(fc) >= {"q10", "q20", "q50", "q80", "q90"}
    assert fc["q10"][0] < fc["q20"][0] < fc["q50"][0] == 3.0 < fc["q80"][0] < fc["q90"][0]


def test_decode_deciles_logit_space_sorts_and_maps_back() -> None:
    h = 3
    base = np.linspace(-1.0, 1.0, 9)
    dec = np.tile(base, (h, 1))
    dec[0, [0, 8]] = dec[0, [8, 0]]  # inject a crossing
    out = cm.decode_deciles(np.zeros(h), dec, "logit", quantiles=[0.1, 0.3, 0.9])
    assert set(out) == {"point", "q10", "q30", "q50", "q90"}
    assert out["point"] == [0.5] * h
    assert out["q10"][0] == pytest.approx(float(cm.sigmoid(-1.0)), abs=1e-6)  # crossing repaired
    assert all(a < b < c for a, b, c in zip(out["q10"], out["q50"], out["q90"]))


def test_decode_deciles_nonneg_and_shape_check() -> None:
    out = cm.decode_deciles(np.array([-0.2, 0.1]), np.full((2, 9), -0.5), "raw", nonneg=True)
    assert out["point"] == [0.0, 0.1] and out["q10"] == [0.0, 0.0]
    with pytest.raises(ValueError):
        cm.decode_deciles(np.zeros(3), np.zeros((3, 10)), "raw")


def test_fallback_and_needs_model() -> None:
    req = cm.validate_forecast_request({"series": [{"id": "a", "values": [0.4, 0.5]}], "horizon": 2})
    assert not cm.needs_model(req)
    out = cm.fallback_forecasts(req)
    assert out["forecasts"][0]["id"] == "a" and out["forecasts"][0]["model"] == cm.RW_MODEL
    req2 = cm.validate_forecast_request({"series": [{"id": "b", "values": [0.5] * 16}], "horizon": 2})
    assert cm.needs_model(req2)


# ───────────────────────────── scoring & backtest ─────────────────────────────


def test_pinball_loss_values() -> None:
    assert cm.pinball_loss(1.0, 1.0, 0.9) == 0.0
    assert cm.pinball_loss(1.0, 0.0, 0.9) == pytest.approx(0.9)  # under-forecast
    assert cm.pinball_loss(0.0, 1.0, 0.9) == pytest.approx(0.1)  # over-forecast
    np.testing.assert_allclose(cm.pinball_loss([0, 2], [1, 1], 0.5), [0.5, 0.5])
    fc = {"q10": [0.5], "q50": [0.5], "q90": [0.5]}
    assert cm.mean_pinball([0.5], fc) == 0.0


def test_skill_score() -> None:
    assert cm.skill_score(0.5, 1.0) == 0.5
    assert cm.skill_score(None, 1.0) is None
    assert cm.skill_score(0.5, 0.0) is None


def test_rolling_origin_splits() -> None:
    assert cm.rolling_origin_splits(100, 10, 3) == [70, 80, 90]
    assert cm.rolling_origin_splits(40, 10, 5) == [20, 30]  # cutoffs < 16 dropped
    assert cm.rolling_origin_splits(20, 10, 3) == []
    with pytest.raises(ValueError):
        cm.rolling_origin_splits(10, 0, 1)


def _oracle(full: np.ndarray) -> cm.ForecastFn:
    """Forecaster that knows the future of ``full``: pinball loss 0."""

    def fn(contexts: list[np.ndarray], horizon: int) -> list[dict[str, Any]]:
        futures = [list(full[len(c) : len(c) + horizon]) for c in contexts]
        return [{"q10": y, "q50": y, "q90": y} for y in futures]

    return fn


def test_backtest_series_oracle_vs_random_walk() -> None:
    rng = np.random.default_rng(7)
    v = cm.sigmoid(np.cumsum(rng.normal(0, 0.1, 120)))
    series = [{"id": "m1", "values": list(v)}, {"id": "short", "values": [0.5] * 10}]
    per = cm.backtest_series(series, horizon=8, folds=4, forecast_fn=_oracle(v))
    m1, short = per
    assert m1["folds"] == 4 and m1["timesfm_pinball"] == 0.0 and m1["rw_pinball"] > 0
    assert m1["skill"] == 1.0 and m1["coverage80"]["timesfm"] == 1.0
    assert short["folds"] == 0 and short["skill"] is None
    agg = cm.aggregate_backtest(per)
    assert agg["series"] == 1 and agg["folds"] == 4 and agg["skill"] == 1.0


def test_backtest_random_walk_against_itself_has_zero_skill() -> None:
    v = list(cm.sigmoid(np.cumsum(np.random.default_rng(3).normal(0, 0.2, 80))))

    def rw_fn(contexts: list[np.ndarray], horizon: int) -> list[dict[str, Any]]:
        return [cm.random_walk_forecast(c, horizon) for c in contexts]

    (r,) = cm.backtest_series([{"id": "x", "values": v}], 5, 3, rw_fn)
    assert r["skill"] == pytest.approx(0.0, abs=1e-12)


def test_backtest_rejects_misaligned_forecaster() -> None:
    with pytest.raises(RuntimeError):
        cm.backtest_series([{"id": "x", "values": [0.5] * 40}], 5, 2, lambda c, h: [])


def test_aggregate_is_fold_weighted() -> None:
    per = [
        {"folds": 1, "timesfm_pinball": 1.0, "rw_pinball": 2.0, "coverage80": {"timesfm": 1.0, "rw": 0.0}},
        {"folds": 3, "timesfm_pinball": 2.0, "rw_pinball": 2.0, "coverage80": {"timesfm": 0.0, "rw": 1.0}},
        {"folds": 0, "timesfm_pinball": None, "rw_pinball": None, "coverage80": {"timesfm": None, "rw": None}},
    ]
    agg = cm.aggregate_backtest(per)
    assert agg["timesfm_pinball"] == pytest.approx(1.75) and agg["rw_pinball"] == 2.0
    assert agg["skill"] == pytest.approx(0.125) and agg["coverage80"]["rw"] == pytest.approx(0.75)
    assert cm.aggregate_backtest([])["skill"] is None


def test_chunked() -> None:
    assert cm.chunked([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]
    with pytest.raises(ValueError):
        cm.chunked([1], 0)


# ───────────────────────────── validation ─────────────────────────────


def _fc_body(**over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"series": [{"id": "a", "values": [0.1, 0.2, 0.3], "step_sec": 60}], "horizon": 4}
    body.update(over)
    return body


def test_validate_forecast_defaults_and_idempotence() -> None:
    req = cm.validate_forecast_request(_fc_body())
    assert req["space"] == "logit" and req["quantiles"] == [0.1, 0.5, 0.9] and req["horizon"] == 4
    assert req["series"][0] == {"id": "a", "values": [0.1, 0.2, 0.3], "step_sec": 60}
    assert cm.validate_forecast_request(req) == req
    req = cm.validate_forecast_request(_fc_body(quantiles=[0.2, 0.8], space="raw"))
    assert req["quantiles"] == [0.1, 0.2, 0.5, 0.8, 0.9] and req["space"] == "raw"


@pytest.mark.parametrize(
    "body, status",
    [
        ([], 400),
        (_fc_body(series=[]), 400),
        (_fc_body(horizon=0), 400),
        (_fc_body(horizon=10_000), 400),
        (_fc_body(horizon=True), 400),
        (_fc_body(horizon=4.0), 400),
        (_fc_body(space="log"), 400),
        (_fc_body(quantiles=[0.25]), 400),
        (_fc_body(quantiles="0.1"), 400),
        (_fc_body(series=[{"id": "a", "values": [0.1, float("nan")]}]), 400),
        (_fc_body(series=[{"id": "a", "values": [0.1, "0.2"]}]), 400),
        (_fc_body(series=[{"id": "a", "values": [1.5]}]), 400),
        (_fc_body(series=[{"id": "", "values": [0.5]}]), 400),
        (_fc_body(series=[{"id": "a", "values": [0.5]}, {"id": "a", "values": [0.5]}]), 400),
        (_fc_body(series=[{"id": "a", "values": [0.5], "step_sec": 0}]), 400),
        (_fc_body(series=[{"id": str(i), "values": [0.5]} for i in range(cm.MAX_SERIES + 1)]), 413),
    ],
)
def test_validate_forecast_rejects(body: Any, status: int) -> None:
    with pytest.raises(cm.ValidationError) as e:
        cm.validate_forecast_request(body)
    assert e.value.status == status


def test_raw_space_allows_values_outside_unit_interval() -> None:
    req = cm.validate_forecast_request(_fc_body(space="raw", series=[{"id": "v", "values": [120.0, -3.0]}]))
    assert req["series"][0]["values"] == [120.0, -3.0]


def test_validate_backtest() -> None:
    req = cm.validate_backtest_request({"series": [{"id": "a", "values": [0.5] * 20}], "horizon": 5})
    assert req["folds"] == 5 and req["space"] == "logit"
    with pytest.raises(cm.ValidationError):
        cm.validate_backtest_request({"series": [{"id": "a", "values": [0.5]}], "horizon": 5, "folds": 0})


Q = {
    "dir": {"type": "choice", "instructions": "Which way?", "criteria": {"up": "rises", "down": None}},
    "size": {"type": "score", "instructions": "How big?", "criteria": ["none", "small", "large"]},
    "res": {"type": "noul", "instructions": "Resolves it?", "criteria": {"true": "yes", "false": "no"}},
}


def test_validate_decide_request() -> None:
    req = cm.validate_decide_request({"items": [{"state": "news", "questions": Q}, {"state": {"a": 1}, "questions": Q}]})
    assert req["model"] is None and len(req["items"]) == 2
    assert cm.validate_decide_request(req) == req  # the runtime re-validates normalised requests
    ml = cm.validate_decide_request({"items": [{"state": "x", "questions": Q}], "model": "multilingual"})
    assert ml["model"] == "multilingual" and cm.validate_decide_request(ml) == ml


@pytest.mark.parametrize(
    "questions",
    [
        {},
        {"q": {"type": "bool", "instructions": "x"}},
        {"q": {"type": "noul"}},
        {"q": {"type": "noul", "instructions": "   "}},
        {"q": {"type": "choice", "instructions": "x", "criteria": {}}},
        {"q": {"type": "score", "instructions": "x", "criteria": {"a": 1}}},
        {"q": {"type": "noul", "instructions": "x", "criteria": {"yes": "y"}}},
        {"q": {"type": "choice", "instructions": "x", "criteria": ["a"], "labels": {"true": "A", "false": "B"}}},
        {"q": {"type": "noul", "instructions": "x", "labels": {"true": "A", "false": "A"}}},
    ],
)
def test_validate_questions_rejects(questions: Any) -> None:
    with pytest.raises(cm.ValidationError):
        cm.validate_questions(questions)


def test_validate_decide_rejects_bad_model_and_state() -> None:
    with pytest.raises(cm.ValidationError):
        cm.validate_decide_request({"items": [{"state": "x", "questions": Q}], "model": "jev-latest"})
    with pytest.raises(cm.ValidationError):
        cm.validate_decide_request({"items": [{"state": None, "questions": Q}]})
    with pytest.raises(cm.ValidationError) as e:
        cm.validate_decide_request({"items": [{"state": "x" * (cm.MAX_STATE_CHARS + 1), "questions": Q}]})
    assert e.value.status == 413


@pytest.mark.parametrize(
    "name, key",
    [
        (None, None), ("", None), ("auto", None), ("jev-latest", None), ("convaiinnovations/laya", None),
        ("english", "english"), ("EN", "english"), ("laya", "english"), ("ml", "multilingual"),
        ("convaiinnovations/laya-multilingual", "multilingual"), ("typed_decisions", "typed-decisions"),
    ],
)
def test_resolve_laya_model(name: Any, key: str | None) -> None:
    assert cm.resolve_laya_model(name) == key


def test_validate_systemone_status_codes() -> None:
    ok = cm.validate_systemone_request({"state": "s", "questions": Q, "model": "jev-latest"})
    assert ok["model"] is None and ok["questions"] == Q
    ml = cm.validate_systemone_request({"state": "s", "questions": Q, "model": "ml"})
    assert cm.validate_systemone_request(ml) == ml  # idempotent (the runtime re-validates)
    with pytest.raises(cm.ValidationError) as e:
        cm.validate_systemone_request({"state": "s"})
    assert e.value.status == 400
    with pytest.raises(cm.ValidationError) as e:
        cm.validate_systemone_request({"state": "s", "questions": {"q": {"type": "nope", "instructions": "x"}}})
    assert e.value.status == 422
    batch = cm.validate_systemone_batch({"requests": [{"state": "a", "questions": Q}, {"state": "b", "questions": Q}]})
    assert len(batch) == 2
    with pytest.raises(cm.ValidationError):
        cm.validate_systemone_batch({"requests": []})


# ───────────────────────────── Laya normalisation ─────────────────────────────

# Shape copied from a real laya 0.3.20 Router.predict_batch() result (CPU run).
LAYA_RESULT = {
    "model": "laya-rl-agent",
    "answers": {
        "direction": {
            "type": "choice", "choice": "up", "probabilities": {"up": 0.6484, "down": 0.1037, "none": 0.2479},
            "confidence": 0.2157, "answer_confidence": 0.6484, "action": {"act_probability": 1.0},
        },
        "magnitude": {
            "type": "score", "score": 0.967, "legend": {"0": "none", "1": "small", "2": "large"},
            "probabilities": {"0": 0.1889, "1": 0.6552, "2": 0.1559}, "confidence": 0.1976,
            "answer_confidence": 0.6552, "action": {"act_probability": 1.0},
        },
        "resolves": {
            "type": "noul", "noul": 0.1894, "confidence": 0.8106, "answer_confidence": 0.8106,
            "action": {"act_probability": 1.0},
        },
    },
    "usage": {"input_tokens": 167, "output_tokens": 0},
    "routing": {"model": "english", "repo": "convaiinnovations/laya", "reason": "English Latin text"},
}


def test_normalize_laya_result() -> None:
    out = cm.normalize_laya_result(LAYA_RESULT, 12.3456)
    assert out["model"] == "laya" and out["latency_ms"] == 12.346
    a = out["answers"]
    assert a["direction"] == {"choice": "up", "probs": {"up": 0.6484, "down": 0.1037, "none": 0.2479}, "confidence": 0.6484}
    assert a["magnitude"]["score"] == 0.967 and a["magnitude"]["probs"]["1"] == 0.6552
    assert a["magnitude"]["confidence"] == 0.6552
    assert a["resolves"] == {"noul": 0.1894, "confidence": 0.8106}


def test_normalize_laya_answer_fallbacks() -> None:
    assert cm.normalize_laya_answer({"noul": 0.3})["confidence"] == 0.7
    ans = cm.normalize_laya_answer({"type": "choice", "choice": "a", "probabilities": {"a": 0.7, "b": 0.3}})
    assert ans["confidence"] == 0.7
    with pytest.raises(ValueError):
        cm.normalize_laya_answer({"type": "mystery"})
    assert cm.laya_model_name({"routing": {"model": "multilingual"}}) == "laya-multilingual"
    assert cm.laya_model_name({}) == "laya"


# ───────────────────────────── auth ─────────────────────────────


@pytest.mark.parametrize(
    "header, expected, ok",
    [
        ("Bearer s3cret", "s3cret", True),
        ("bearer   s3cret ", "s3cret", True),
        ("Bearer wrong", "s3cret", False),
        ("s3cret", "s3cret", False),
        ("Basic s3cret", "s3cret", False),
        (None, "s3cret", False),
        ("Bearer s\xe9cret", "s3cret", False),  # latin-1 header must not raise
        ("Bearer anything", None, False),  # fail closed when unset
        ("Bearer ", "", False),
    ],
)
def test_check_bearer(header: str | None, expected: str | None, ok: bool) -> None:
    assert cm.check_bearer(header, expected) is ok

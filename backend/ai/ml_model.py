"""
Optional per-timeframe ML scaffold for the AI evaluator.

A separate GradientBoostingClassifier is trained per timeframe. Each model
sees only predictions made on its own TF (filtered via `evidence.tf`) and is
graded against TF-appropriate horizon outcomes (filled in by
evaluator.resolve_outcomes using TIMEFRAMES[tf]["prediction_horizon_minutes"]).

Falls back silently per-TF if insufficient data (<ML_MIN_SAMPLES rows with
outcomes for that TF). Models are persisted as picker_ml_model_<tf>.pkl.
"""
from __future__ import annotations

import json
import logging
import pickle
from pathlib import Path

import numpy as np

from config import ML_MIN_SAMPLES, BASE_DIR, TIMEFRAMES, PRIMARY_TIMEFRAME
from ai.schemas import EvidenceFields

logger = logging.getLogger(__name__)

_FEATURES = [
    "ema9", "ema21",
    "ema_state_enc",       # 1=BULLISH, -1=BEARISH, 0=unknown
    "vwap_distance_pct",
    "vwap_motion_enc",     # 1=AWAY_ABOVE, -1=AWAY_BELOW, 0=TOWARD/FLAT
    "price_vs_vwap_enc",   # 1=ABOVE, -1=BELOW
    "daily_trend_enc",     # 1=BULL, -1=BEAR, 0=NEUTRAL
    "price_vs_poc",        # price - poc
    "dist_to_support",     # price - nearest_support (None → 0)
    "dist_to_resistance",  # nearest_resistance - price (None → 0)
    "recent_return_5m",
    "recent_volatility",
]

_LABEL_MAP = {"UP": 1, "DOWN": -1, "FLAT": 0}
_LABEL_REVERSE = {1: "UP", -1: "DOWN", 0: "NEUTRAL"}


def _model_path(tf: str) -> Path:
    return BASE_DIR / f"picker_ml_model_{tf}.pkl"


def _encode_evidence(ev: EvidenceFields) -> np.ndarray:
    price = ev.price or 0.0
    vwap = ev.vwap or price

    ema_state_enc = 1 if ev.ema_state == "BULLISH" else (-1 if ev.ema_state == "BEARISH" else 0)
    price_vs_vwap_enc = 1 if ev.price_vs_vwap == "ABOVE" else -1 if ev.price_vs_vwap == "BELOW" else 0
    daily_trend_enc = 1 if ev.daily_trend == "BULL" else (-1 if ev.daily_trend == "BEAR" else 0)

    if ev.vwap_motion == "AWAY" and ev.price_vs_vwap == "ABOVE":
        vwap_motion_enc = 1.0
    elif ev.vwap_motion == "AWAY" and ev.price_vs_vwap == "BELOW":
        vwap_motion_enc = -1.0
    else:
        vwap_motion_enc = 0.0

    poc = ev.poc or price
    sup = ev.nearest_support or price
    res = ev.nearest_resistance or price

    return np.array([
        ev.ema9 or price,
        ev.ema21 or price,
        ema_state_enc,
        ev.vwap_distance_pct or 0.0,
        vwap_motion_enc,
        price_vs_vwap_enc,
        daily_trend_enc,
        price - poc,
        price - sup,
        res - price,
        ev.recent_return_5m or 0.0,
        ev.recent_volatility or 0.0,
    ], dtype=float).reshape(1, -1)


class MLEvaluator:
    """Single-timeframe ML evaluator. Use MLRegistry for multi-TF orchestration."""

    def __init__(self, tf: str) -> None:
        self.tf = tf
        self._model = None
        self._trained = False
        self._load()

    def _load(self) -> None:
        path = _model_path(self.tf)
        if path.exists():
            try:
                with open(path, "rb") as f:
                    self._model = pickle.load(f)
                self._trained = True
                logger.info("ML model loaded tf=%s from %s", self.tf, path)
            except Exception as exc:
                logger.warning("Failed to load ML model tf=%s: %s", self.tf, exc)

    def _save(self) -> None:
        path = _model_path(self.tf)
        with open(path, "wb") as f:
            pickle.dump(self._model, f)

    def train(self, rows: list[dict]) -> None:
        """
        rows: list of dicts with keys: evidence (JSON str), outcome ('UP'|'DOWN'|'FLAT').
        Caller is responsible for pre-filtering rows to this TF.
        """
        from sklearn.ensemble import GradientBoostingClassifier

        if len(rows) < ML_MIN_SAMPLES:
            logger.info("Skipping ML training tf=%s: only %d samples (need %d)",
                        self.tf, len(rows), ML_MIN_SAMPLES)
            return

        X, y = [], []
        for row in rows:
            outcome = row.get("outcome")
            if outcome not in _LABEL_MAP:
                continue
            try:
                ev_dict = json.loads(row["evidence"]) if isinstance(row["evidence"], str) else row["evidence"]
                ev = EvidenceFields(**ev_dict)
                X.append(_encode_evidence(ev).flatten())
                y.append(_LABEL_MAP[outcome])
            except Exception:
                continue

        if len(X) < ML_MIN_SAMPLES:
            return

        self._model = GradientBoostingClassifier(n_estimators=100, max_depth=3, random_state=42)
        self._model.fit(np.array(X), np.array(y))
        self._trained = True
        self._save()
        logger.info("ML model trained tf=%s on %d samples", self.tf, len(X))

    def predict(self, evidence: EvidenceFields) -> tuple[str, float] | None:
        """Returns (direction, confidence) or None if model not trained."""
        if not self._trained or self._model is None:
            return None
        try:
            X = _encode_evidence(evidence)
            label = int(self._model.predict(X)[0])
            proba = self._model.predict_proba(X)[0]
            confidence = float(max(proba))
            direction = _LABEL_REVERSE.get(label, "NEUTRAL")
            return direction, round(confidence, 4)
        except Exception as exc:
            logger.warning("ML prediction failed tf=%s: %s", self.tf, exc)
            return None


class MLRegistry:
    """Routes predict/train calls to the correct per-TF MLEvaluator."""

    def __init__(self) -> None:
        self._by_tf: dict[str, MLEvaluator] = {tf: MLEvaluator(tf) for tf in TIMEFRAMES}

    def for_tf(self, tf: str | None) -> MLEvaluator:
        if tf is None or tf not in self._by_tf:
            tf = PRIMARY_TIMEFRAME
        return self._by_tf[tf]

    def predict(self, evidence: EvidenceFields) -> tuple[str, float] | None:
        """Route prediction to the model matching evidence.tf."""
        return self.for_tf(evidence.tf).predict(evidence)

    def train(self, tf: str, rows: list[dict]) -> None:
        self.for_tf(tf).train(rows)


# Module-level singleton — TF-aware
ml_registry = MLRegistry()

# Backward-compat alias: anything still importing `ml_evaluator` gets the
# registry, which exposes a compatible `predict()` method.
ml_evaluator = ml_registry

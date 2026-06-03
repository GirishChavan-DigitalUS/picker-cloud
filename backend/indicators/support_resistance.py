"""
Multi-timeframe Support and Resistance levels.

Derives S/R from:
- 5-min swing highs/lows (from swings.py)
- 1-hour aggregated pivot highs/lows
- Daily aggregated pivot highs/lows

Each level is assigned a strength score based on how many timeframes
confirm it and how many times price has touched it.
"""
from __future__ import annotations

import pandas as pd

from indicators.swings import compute_swings

_TOUCH_TOLERANCE_PCT = 0.002  # 0.2% tolerance for "touch" counting
_MAX_LEVELS = 10               # keep top N levels per side


def _resample_pivots(df_5m: pd.DataFrame, rule: str, left: int, right: int) -> tuple[list[float], list[float]]:
    """Aggregate df_5m to *rule* and find pivot highs/lows."""
    if df_5m.empty:
        return [], []
    d = df_5m.copy()
    d["timestamp"] = pd.to_datetime(d["timestamp"], utc=True)
    d = d.set_index("timestamp").sort_index()
    resampled = d[["high", "low", "close"]].resample(rule).agg({"high": "max", "low": "min", "close": "last"}).dropna()
    resampled = resampled.reset_index()
    resampled = resampled.rename(columns={"timestamp": "timestamp"})

    swings = compute_swings(resampled.rename(columns={"high": "high", "low": "low"}), left=left, right=right)
    highs = [p for p, _ in swings.get("all_swing_highs", [])]
    lows = [p for p, _ in swings.get("all_swing_lows", [])]
    return highs, lows


def _count_touches(level: float, df: pd.DataFrame, tol_pct: float) -> int:
    tol = level * tol_pct
    touches = ((df["high"] >= level - tol) & (df["low"] <= level + tol)).sum()
    return int(touches)


def compute_support_resistance(df_5m: pd.DataFrame, current_price: float) -> dict:
    """
    Returns:
      nearest_support: float | None
      nearest_resistance: float | None
      all_supports: list[{"price": float, "strength": int}]
      all_resistances: list[{"price": float, "strength": int}]
    """
    if df_5m.empty:
        return _empty()

    # 5-min swings
    swings_5m = compute_swings(df_5m)
    highs_5m = [p for p, _ in swings_5m.get("all_swing_highs", [])]
    lows_5m = [p for p, _ in swings_5m.get("all_swing_lows", [])]

    # 1h and daily
    highs_1h, lows_1h = _resample_pivots(df_5m, "1h", left=2, right=2)
    highs_d, lows_d = _resample_pivots(df_5m, "1D", left=1, right=1)

    all_res_raw = highs_5m + highs_1h + highs_d
    all_sup_raw = lows_5m + lows_1h + lows_d

    def build_levels(raw: list[float], side: str) -> list[dict]:
        seen: list[dict] = []
        for price in raw:
            merged = False
            for lvl in seen:
                if abs(lvl["price"] - price) / max(lvl["price"], 1e-9) < _TOUCH_TOLERANCE_PCT * 3:
                    lvl["strength"] += 1
                    lvl["price"] = (lvl["price"] + price) / 2  # average
                    merged = True
                    break
            if not merged:
                touches = _count_touches(price, df_5m, _TOUCH_TOLERANCE_PCT)
                seen.append({"price": round(price, 4), "strength": touches + 1})
        seen.sort(key=lambda x: x["strength"], reverse=True)
        return seen[:_MAX_LEVELS]

    resistances = build_levels([p for p in all_res_raw if p > current_price], "res")
    supports = build_levels([p for p in all_sup_raw if p < current_price], "sup")

    nearest_resistance = min(resistances, key=lambda x: x["price"])["price"] if resistances else None
    nearest_support = max(supports, key=lambda x: x["price"])["price"] if supports else None

    return {
        "nearest_support": nearest_support,
        "nearest_resistance": nearest_resistance,
        "all_supports": supports,
        "all_resistances": resistances,
    }


def _empty() -> dict:
    return {
        "nearest_support": None,
        "nearest_resistance": None,
        "all_supports": [],
        "all_resistances": [],
    }

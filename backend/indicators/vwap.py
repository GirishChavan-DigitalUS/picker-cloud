"""
Session-aware VWAP indicator.

VWAP resets at each session boundary (pre / regular / after-hours).
Matches TradingView's VWAP calculation: cumsum(TP * vol) / cumsum(vol)
where TP = (H + L + C) / 3.
"""
from __future__ import annotations

import pandas as pd


def compute_vwap(df: pd.DataFrame, current_price: float) -> dict:
    """
    df must have columns: timestamp, high, low, close, volume, session
    sorted oldest → newest.

    Returns a dict with vwap, price_vs_vwap, vwap_distance_pct,
    vwap_motion (TOWARD/AWAY/FLAT), and vwap_slope.
    """
    if df.empty or "session" not in df.columns:
        return _empty()

    df = df.copy()
    df["tp"] = (df["high"] + df["low"] + df["close"]) / 3.0
    df["tp_vol"] = df["tp"] * df["volume"]

    # Reset VWAP at each session boundary
    df["session_group"] = (df["session"] != df["session"].shift(1)).cumsum()

    df["cum_tp_vol"] = df.groupby("session_group")["tp_vol"].cumsum()
    df["cum_vol"] = df.groupby("session_group")["volume"].cumsum()
    df["vwap"] = df["cum_tp_vol"] / df["cum_vol"].replace(0, float("nan"))

    if df["vwap"].isna().all():
        return _empty()

    current_vwap = float(df["vwap"].iloc[-1])
    prev_vwap = float(df["vwap"].iloc[-2]) if len(df) >= 2 else current_vwap

    prev_price = float(df["close"].iloc[-2]) if len(df) >= 2 else current_price
    prev_dist = abs(prev_price - prev_vwap)
    curr_dist = abs(current_price - current_vwap)

    if curr_dist < prev_dist * 0.995:
        motion = "TOWARD"
    elif curr_dist > prev_dist * 1.005:
        motion = "AWAY"
    else:
        motion = "FLAT"

    distance_pct = (
        round((current_price - current_vwap) / current_vwap * 100, 4)
        if current_vwap != 0 else 0.0
    )

    slope = round(current_vwap - prev_vwap, 4)

    return {
        "vwap": round(current_vwap, 4),
        "price_vs_vwap": "ABOVE" if current_price >= current_vwap else "BELOW",
        "vwap_distance_pct": distance_pct,
        "vwap_motion": motion,
        "vwap_slope": slope,
    }


def _empty() -> dict:
    return {
        "vwap": None,
        "price_vs_vwap": None,
        "vwap_distance_pct": None,
        "vwap_motion": None,
        "vwap_slope": None,
    }

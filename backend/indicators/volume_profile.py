"""
Session Volume Profile and Point of Control (POC).

Buckets the current session's 5-min candles into price bins and identifies
the bin with highest cumulative volume (POC).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

_NUM_BINS = 50


def compute_volume_profile(df: pd.DataFrame) -> dict:
    """
    df must have columns: high, low, close, volume, session.
    Filters to the last complete/ongoing session and computes the POC.
    Returns {"poc": float | None}.
    """
    if df.empty or "session" not in df.columns:
        return {"poc": None}

    last_session = df["session"].iloc[-1]
    session_df = df[df["session"] == last_session].copy()

    if session_df.empty or session_df["volume"].sum() == 0:
        return {"poc": None}

    price_min = float(session_df["low"].min())
    price_max = float(session_df["high"].max())

    if price_min >= price_max:
        return {"poc": round(float(session_df["close"].iloc[-1]), 4)}

    bins = np.linspace(price_min, price_max, _NUM_BINS + 1)
    bin_volume = np.zeros(_NUM_BINS)

    for _, row in session_df.iterrows():
        # Distribute bar volume evenly across bins that fall within [low, high]
        bar_bins = np.where((bins[:-1] <= row["high"]) & (bins[1:] >= row["low"]))[0]
        if len(bar_bins) > 0:
            bin_volume[bar_bins] += row["volume"] / len(bar_bins)

    poc_idx = int(np.argmax(bin_volume))
    poc_price = (bins[poc_idx] + bins[poc_idx + 1]) / 2.0

    return {"poc": round(poc_price, 4)}

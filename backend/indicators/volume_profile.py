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

    # Vectorized volume distribution: extract arrays and loop over numpy
    # values directly (avoids pandas iterrows overhead).
    highs = session_df["high"].values.astype(float)
    lows = session_df["low"].values.astype(float)
    volumes = session_df["volume"].values.astype(float)
    bin_starts = bins[:-1]
    bin_ends = bins[1:]

    for h, l, v in zip(highs, lows, volumes):
        bar_bins = np.where((bin_starts <= h) & (bin_ends >= l))[0]
        if len(bar_bins) > 0:
            bin_volume[bar_bins] += v / len(bar_bins)

    poc_idx = int(np.argmax(bin_volume))
    poc_price = (bins[poc_idx] + bins[poc_idx + 1]) / 2.0

    return {"poc": round(poc_price, 4)}

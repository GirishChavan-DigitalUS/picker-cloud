"""
Daily trend indicator.

Aggregates 5-min candles to daily bars and detects:
- BULL: higher highs AND higher lows over last N daily bars
- BEAR: lower highs AND lower lows
- NEUTRAL: otherwise
"""
from __future__ import annotations

import pandas as pd

_TREND_LOOKBACK = 3  # number of daily bars to compare


def compute_daily_trend(df_5m: pd.DataFrame) -> dict:
    """
    df_5m must have columns: timestamp (ISO-8601), high, low, close.
    Returns {"daily_trend": "BULL" | "BEAR" | "NEUTRAL"}.
    """
    if df_5m.empty:
        return {"daily_trend": "NEUTRAL"}

    df = df_5m.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df = df.set_index("timestamp").sort_index()

    daily = df["close"].resample("1D").ohlc().dropna()
    daily = daily.rename(columns={"open": "d_open", "high": "d_high", "low": "d_low", "close": "d_close"})

    if len(daily) < _TREND_LOOKBACK + 1:
        return {"daily_trend": "NEUTRAL"}

    recent = daily.tail(_TREND_LOOKBACK + 1)
    highs = recent["d_high"].values
    lows = recent["d_low"].values

    higher_highs = all(highs[i] > highs[i - 1] for i in range(1, len(highs)))
    higher_lows = all(lows[i] > lows[i - 1] for i in range(1, len(lows)))
    lower_highs = all(highs[i] < highs[i - 1] for i in range(1, len(highs)))
    lower_lows = all(lows[i] < lows[i - 1] for i in range(1, len(lows)))

    if higher_highs and higher_lows:
        trend = "BULL"
    elif lower_highs and lower_lows:
        trend = "BEAR"
    else:
        trend = "NEUTRAL"

    return {"daily_trend": trend}

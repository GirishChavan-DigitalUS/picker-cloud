"""
EMA crossover indicator.

Uses pandas ewm(span=N, adjust=False) which matches TradingView's EMA formula.
"""
from __future__ import annotations

import pandas as pd


def compute_ema(closes: pd.Series, span: int) -> pd.Series:
    """Exponential moving average matching TradingView's EMA definition."""
    return closes.ewm(span=span, adjust=False).mean()


def compute_crossover(df: pd.DataFrame) -> dict:
    """
    Given a DataFrame with a 'close' column (sorted oldest→newest),
    return a dict with ema9, ema21, ema50, ema_state, and ema_cross_ts.

    ema_cross_ts is the ISO timestamp of the most recent crossover event.
    """
    if len(df) < 21:
        return {
            "ema9": None,
            "ema21": None,
            "ema50": None,
            "ema_state": None,
            "ema_cross_ts": None,
        }

    closes = df["close"].astype(float)
    ema9 = compute_ema(closes, 9)
    ema21 = compute_ema(closes, 21)
    ema50 = compute_ema(closes, 50) if len(closes) >= 50 else None

    above = ema9 > ema21
    crossover_mask = above != above.shift(1)

    cross_ts = None
    if crossover_mask.any():
        last_cross_idx = crossover_mask[::-1].idxmax()
        ts_col = df["timestamp"] if "timestamp" in df.columns else df.index
        cross_ts = str(ts_col.loc[last_cross_idx]) if hasattr(ts_col, "loc") else str(ts_col[last_cross_idx])

    current_state = "BULLISH" if float(ema9.iloc[-1]) > float(ema21.iloc[-1]) else "BEARISH"

    e9  = round(float(ema9.iloc[-1]),  4)
    e21 = round(float(ema21.iloc[-1]), 4)
    # Spread: (ema9 - ema21) / ema21 * 100  → positive = bullish separation
    ema_spread_pct = round((e9 - e21) / e21 * 100, 4) if e21 != 0 else None

    return {
        "ema9":           e9,
        "ema21":          e21,
        "ema50":          round(float(ema50.iloc[-1]), 4) if ema50 is not None else None,
        "ema_state":      current_state,
        "ema_cross_ts":   cross_ts,
        "ema_spread_pct": ema_spread_pct,
    }

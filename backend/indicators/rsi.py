"""
RSI-14 computation from 5-min OHLCV bars.

Uses Wilder's smoothing (EWM with alpha=1/period, adjust=False),
which matches TradingView's RSI definition.
"""
from __future__ import annotations

import pandas as pd

RSI_PERIOD = 14
OVERBOUGHT = 70.0
OVERSOLD   = 30.0


def compute_rsi(df: pd.DataFrame) -> dict:
    """
    Returns:
        rsi_14   float | None  – current RSI value (0–100)
        rsi_state str  | None  – OVERBOUGHT | OVERSOLD | NEUTRAL
    Requires at least RSI_PERIOD + 1 bars; returns None fields otherwise.
    """
    if len(df) < RSI_PERIOD + 1:
        return {"rsi_14": None, "rsi_state": None}

    closes = df["close"].astype(float)
    delta  = closes.diff()

    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)

    # Wilder's smoothing = EWM with alpha=1/period
    avg_gain = gain.ewm(alpha=1 / RSI_PERIOD, min_periods=RSI_PERIOD, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / RSI_PERIOD, min_periods=RSI_PERIOD, adjust=False).mean()

    last_loss = float(avg_loss.iloc[-1])
    if last_loss == 0:
        rsi_val = 100.0
    else:
        rs      = float(avg_gain.iloc[-1]) / last_loss
        rsi_val = round(100.0 - (100.0 / (1.0 + rs)), 2)

    if rsi_val >= OVERBOUGHT:
        state = "OVERBOUGHT"
    elif rsi_val <= OVERSOLD:
        state = "OVERSOLD"
    else:
        state = "NEUTRAL"

    return {"rsi_14": rsi_val, "rsi_state": state}

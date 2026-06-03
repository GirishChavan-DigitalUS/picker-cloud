"""
EMA crossover signal detector.

Compares the current EMA state against the previously stored one
and emits a signal dict when a crossover occurs.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone


def detect_crossover(ticker: str, prev_ema_state: str | None, current: dict) -> dict | None:
    """
    current: output from indicators.ema.compute_crossover
    Returns a signal dict or None if no crossover occurred.
    """
    new_state = current.get("ema_state")
    if not new_state or not prev_ema_state:
        return None
    if new_state == prev_ema_state:
        return None

    direction = "UP" if new_state == "BULLISH" else "DOWN"
    return {
        "ticker": ticker,
        "timestamp": current.get("ema_cross_ts") or datetime.now(timezone.utc).isoformat(),
        "signal_type": "ema_cross",
        "direction": direction,
        "details": json.dumps({
            "ema9": current.get("ema9"),
            "ema21": current.get("ema21"),
            "from_state": prev_ema_state,
            "to_state": new_state,
        }),
    }

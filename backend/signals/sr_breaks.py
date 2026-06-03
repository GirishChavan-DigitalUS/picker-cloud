"""
Support / Resistance break signal detector.

Compares the latest close against the previously stored nearest_support
and nearest_resistance to detect breaches.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

_BREAK_THRESHOLD_PCT = 0.001  # price must be 0.1% beyond level to count as a break


def detect_sr_breaks(
    ticker: str,
    current_price: float,
    prev_support: float | None,
    prev_resistance: float | None,
    sr_data: dict,
    timestamp: str | None = None,
) -> list[dict]:
    """
    Returns a (possibly empty) list of signal dicts.
    sr_data: output from indicators.support_resistance.compute_support_resistance
    """
    signals: list[dict] = []
    ts = timestamp or datetime.now(timezone.utc).isoformat()

    nearest_res = sr_data.get("nearest_resistance")
    nearest_sup = sr_data.get("nearest_support")

    # Resistance break: price previously below resistance and now above
    if prev_resistance and nearest_res:
        if current_price > prev_resistance * (1 + _BREAK_THRESHOLD_PCT):
            signals.append({
                "ticker": ticker,
                "timestamp": ts,
                "signal_type": "sr_break",
                "direction": "UP",
                "details": json.dumps({
                    "level": round(prev_resistance, 4),
                    "side": "resistance",
                    "price": round(current_price, 4),
                }),
            })

    # Support break: price previously above support and now below
    if prev_support and nearest_sup:
        if current_price < prev_support * (1 - _BREAK_THRESHOLD_PCT):
            signals.append({
                "ticker": ticker,
                "timestamp": ts,
                "signal_type": "sr_break",
                "direction": "DOWN",
                "details": json.dumps({
                    "level": round(prev_support, 4),
                    "side": "support",
                    "price": round(current_price, 4),
                }),
            })

    return signals

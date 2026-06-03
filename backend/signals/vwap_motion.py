"""
VWAP reclaim / breakdown signal detector.

Emits a signal when price crosses the VWAP line.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone


def detect_vwap_cross(ticker: str, prev_vs_vwap: str | None, current: dict, timestamp: str | None = None) -> dict | None:
    """
    prev_vs_vwap: previous "price_vs_vwap" value ('ABOVE' | 'BELOW' | None)
    current: output from indicators.vwap.compute_vwap (includes price_vs_vwap)
    Returns a signal dict or None.
    """
    new_vs = current.get("price_vs_vwap")
    if not new_vs or not prev_vs_vwap:
        return None
    if new_vs == prev_vs_vwap:
        return None

    signal_type = "vwap_reclaim" if new_vs == "ABOVE" else "vwap_breakdown"
    direction = "UP" if new_vs == "ABOVE" else "DOWN"
    ts = timestamp or datetime.now(timezone.utc).isoformat()

    return {
        "ticker": ticker,
        "timestamp": ts,
        "signal_type": signal_type,
        "direction": direction,
        "details": json.dumps({
            "vwap": current.get("vwap"),
            "distance_pct": current.get("vwap_distance_pct"),
            "from": prev_vs_vwap,
            "to": new_vs,
        }),
    }

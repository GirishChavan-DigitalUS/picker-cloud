"""
Composite alert engine.

Evaluates 5 high-conviction composite signals.  Each requires 3-4 indicators
to agree simultaneously plus a hard AI-confidence gate.

Signal interaction rules apply suppression / downgrade after all candidates
have been collected for the cycle.
"""
from __future__ import annotations

from datetime import datetime, timezone


def _ts() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Individual detectors ────────────────────────────────────────────────────

def _check_high_confidence(
    ticker: str, snap: dict, confidence: float, prediction_dir: str
) -> dict | None:
    """
    HIGH CONFIDENCE SIGNAL – AI model is highly confident in a direction
    with basic indicator confirmation.
      prediction_dir = UP or DOWN
      ema_state agrees with direction
      confidence   >= 0.75
    Fires as a tier-2 alert when stricter composite conditions aren’t met.
    DB dedup prevents re-firing within ALERT_DEDUP_SECS.
    """
    if confidence < 0.75:
        return None
    if prediction_dir not in ("UP", "DOWN"):
        return None
    ema = snap.get("ema_state")
    if prediction_dir == "UP" and ema != "BULLISH":
        return None
    if prediction_dir == "DOWN" and ema != "BEARISH":
        return None
    signal = "HIGH_CONF_BULL" if prediction_dir == "UP" else "HIGH_CONF_BEAR"
    return {
        "signal": signal, "direction": prediction_dir, "tier": 2,
        "ai_confidence": confidence,
        "components": ["ema_state"],
        "suppressed_by": None, "ticker": ticker, "timestamp": _ts(),
    }


def _check_power_trend(
    ticker: str, snap: dict, confidence: float
) -> dict | None:
    """
    POWER TREND – strong directional move with full stack agreement.
      daily_trend   = BULL / BEAR
      ema_state     agrees with daily_trend
      price_vs_vwap = ABOVE (bull) / BELOW (bear)
      vwap_motion   = AWAY
      confidence   >= 0.75
    Fires at most once per session per ticker (enforced by caller).
    """
    if confidence < 0.75:
        return None

    daily = snap.get("daily_trend")
    ema   = snap.get("ema_state")
    pvwap = snap.get("price_vs_vwap")
    motion = snap.get("vwap_motion")

    if daily == "BULL" and ema == "BULLISH" and pvwap == "ABOVE" and motion == "AWAY":
        return {
            "signal": "POWER_TREND_BULL", "direction": "UP", "tier": 1,
            "ai_confidence": confidence,
            "components": ["daily_trend", "ema_state", "vwap_position", "vwap_motion"],
            "suppressed_by": None, "ticker": ticker, "timestamp": _ts(),
        }

    if daily == "BEAR" and ema == "BEARISH" and pvwap == "BELOW" and motion == "AWAY":
        return {
            "signal": "POWER_TREND_BEAR", "direction": "DOWN", "tier": 1,
            "ai_confidence": confidence,
            "components": ["daily_trend", "ema_state", "vwap_position", "vwap_motion"],
            "suppressed_by": None, "ticker": ticker, "timestamp": _ts(),
        }

    return None


def _check_structure_break(
    ticker: str, snap: dict, prev: dict, price: float, confidence: float
) -> dict | None:
    """
    STRUCTURE BREAK – key level broken with volume proof.
      price crosses orb_high/low, prev_day_h/l, or swing_high/low
      rvol > 1.5 on break bar
      ema_state agrees with break direction
      confidence >= 0.70
    """
    if confidence < 0.70:
        return None

    rvol = snap.get("rvol") or 0.0
    if rvol <= 1.5:
        return None

    prev_price = prev.get("price")
    if not prev_price:
        return None

    ema = snap.get("ema_state")

    bull_levels = [
        ("orb_high",       snap.get("orb_high")),
        ("prev_day_high",  snap.get("prev_day_high")),
        ("swing_high",     snap.get("swing_high")),
    ]
    bear_levels = [
        ("orb_low",        snap.get("orb_low")),
        ("prev_day_low",   snap.get("prev_day_low")),
        ("swing_low",      snap.get("swing_low")),
    ]

    if ema == "BULLISH":
        for name, lvl in bull_levels:
            if lvl and prev_price < lvl <= price:
                return {
                    "signal": "STRUCTURE_BREAK_UP", "direction": "UP", "tier": 1,
                    "ai_confidence": confidence,
                    "components": [name, "rvol", "ema_state"],
                    "suppressed_by": None, "ticker": ticker, "timestamp": _ts(),
                    "level_name": name, "level_price": round(lvl, 4),
                }

    if ema == "BEARISH":
        for name, lvl in bear_levels:
            if lvl and prev_price > lvl >= price:
                return {
                    "signal": "STRUCTURE_BREAK_DOWN", "direction": "DOWN", "tier": 1,
                    "ai_confidence": confidence,
                    "components": [name, "rvol", "ema_state"],
                    "suppressed_by": None, "ticker": ticker, "timestamp": _ts(),
                    "level_name": name, "level_price": round(lvl, 4),
                }

    return None


def _check_vwap_reset(
    ticker: str, snap: dict, prev: dict, confidence: float
) -> dict | None:
    """
    VWAP RESET – pullback to VWAP in trending condition (continuation entry).
      price_vs_vwap transitions BELOW→ABOVE (bull) or ABOVE→BELOW (bear)
      daily_trend agrees
      ema_state agrees
      confidence >= 0.65
    """
    if confidence < 0.65:
        return None

    prev_pvwap = prev.get("price_vs_vwap")
    curr_pvwap = snap.get("price_vs_vwap")
    daily = snap.get("daily_trend")
    ema   = snap.get("ema_state")

    if not prev_pvwap or not curr_pvwap or prev_pvwap == curr_pvwap:
        return None

    if prev_pvwap == "BELOW" and curr_pvwap == "ABOVE" and daily == "BULL" and ema == "BULLISH":
        return {
            "signal": "VWAP_RESET_BULL", "direction": "UP", "tier": 2,
            "ai_confidence": confidence,
            "components": ["vwap_reclaim", "daily_trend", "ema_state"],
            "suppressed_by": None, "ticker": ticker, "timestamp": _ts(),
        }

    if prev_pvwap == "ABOVE" and curr_pvwap == "BELOW" and daily == "BEAR" and ema == "BEARISH":
        return {
            "signal": "VWAP_RESET_BEAR", "direction": "DOWN", "tier": 2,
            "ai_confidence": confidence,
            "components": ["vwap_lost", "daily_trend", "ema_state"],
            "suppressed_by": None, "ticker": ticker, "timestamp": _ts(),
        }

    return None


def _check_exhaustion_reversal(
    ticker: str, snap: dict, prev: dict, price: float, confidence: float
) -> dict | None:
    """
    EXHAUSTION REVERSAL – overextended move snapping back (counter-trend).
      vwap_distance_pct > 1.5 %
      vwap_motion flips AWAY → TOWARD
      nearest S/R within 0.3 % of price (level acting as magnet)
      ema_spread_pct compressing (abs < 0.15 %)
      confidence >= 0.72   ← higher bar, counter-trend
    """
    if confidence < 0.72:
        return None

    dist = abs(snap.get("vwap_distance_pct") or 0.0)
    if dist < 1.5:
        return None

    if snap.get("vwap_motion") != "TOWARD" or prev.get("vwap_motion") != "AWAY":
        return None

    pvwap = snap.get("price_vs_vwap")
    nearest_sup = snap.get("nearest_support")
    nearest_res = snap.get("nearest_resistance")

    level_close = False
    if pvwap == "ABOVE" and nearest_res and price:
        level_close = abs(price - nearest_res) / price < 0.003
    elif pvwap == "BELOW" and nearest_sup and price:
        level_close = abs(price - nearest_sup) / price < 0.003

    if not level_close:
        return None

    spread = abs(snap.get("ema_spread_pct") or 999.0)
    if spread > 0.15:
        return None

    direction = "DOWN" if pvwap == "ABOVE" else "UP"
    signal    = "EXHAUSTION_REV_BEAR" if direction == "DOWN" else "EXHAUSTION_REV_BULL"

    return {
        "signal": signal, "direction": direction, "tier": 2,
        "ai_confidence": confidence,
        "components": ["vwap_distance", "vwap_motion_flip", "level_magnet", "ema_compressing"],
        "suppressed_by": None, "ticker": ticker, "timestamp": _ts(),
    }


def _check_poc_magnet(
    ticker: str, snap: dict, prev: dict, price: float, confidence: float
) -> dict | None:
    """
    POC MAGNET – price gravitating to high-volume node (stall / rejection).
      price within 0.25 % of poc_regular or poc_pre
      rvol dropping vs previous cycle
      vwap_motion = FLAT
      confidence >= 0.60   ← informational, lower threshold
    """
    if confidence < 0.60:
        return None

    if snap.get("vwap_motion") != "FLAT":
        return None

    curr_rvol = snap.get("rvol") or 0.0
    prev_rvol = prev.get("rvol") or 0.0
    if prev_rvol > 0 and curr_rvol >= prev_rvol:
        return None

    poc_reg = snap.get("poc_regular") or snap.get("poc")
    poc_pre = snap.get("poc_pre")

    hit: tuple[float, str] | None = None
    for poc_val, name in [(poc_reg, "poc_regular"), (poc_pre, "poc_pre")]:
        if poc_val and price and abs(price - poc_val) / price < 0.0025:
            hit = (poc_val, name)
            break

    if not hit:
        return None

    poc_val, poc_name = hit
    direction = "UP" if price < poc_val else "DOWN"

    return {
        "signal": "POC_MAGNET", "direction": direction, "tier": 3,
        "ai_confidence": confidence,
        "components": [poc_name, "rvol_drying", "vwap_flat"],
        "suppressed_by": None, "ticker": ticker, "timestamp": _ts(),
        "level_price": round(poc_val, 4),
    }


# ── Interaction rules ────────────────────────────────────────────────────────

def _apply_interaction_rules(candidates: list[dict]) -> list[dict]:
    """
    Apply suppression / downgrade rules to a raw candidate list.

    Rules (from the Alert Plan):
      POWER_TREND  + EXHAUSTION in same cycle → suppress both, emit WARNING
      STRUCTURE_BREAK + POC in path          → downgrade STRUCTURE to tier 2
      VWAP_RESET   + conflicting POWER_TREND → suppress VWAP_RESET
      any signal   + confidence < threshold  → already filtered in detectors
    """
    signal_names = {a["signal"] for a in candidates}
    out: list[dict] = []
    emitted_warnings: set[str] = set()

    has_power      = any(s.startswith("POWER_TREND")     for s in signal_names)
    has_exhaustion = any(s.startswith("EXHAUSTION_REV")  for s in signal_names)
    has_poc        = "POC_MAGNET" in signal_names

    for alert in candidates:
        sig = alert["signal"]

        # Rule 1: POWER_TREND + EXHAUSTION → WARNING, suppress both
        if sig.startswith("POWER_TREND") and has_exhaustion:
            warning_key = f"WARNING_{alert['ticker']}"
            if warning_key not in emitted_warnings:
                emitted_warnings.add(warning_key)
                out.append({
                    **alert,
                    "signal": "CONFLICT_WARNING",
                    "direction": "WARNING",
                    "tier": 3,
                    "suppressed_by": "POWER_EXHAUSTION_CONFLICT",
                })
            continue

        if sig.startswith("EXHAUSTION_REV") and has_power:
            continue  # suppressed — WARNING already emitted above

        # Rule 2: STRUCTURE_BREAK + POC in path → downgrade to tier 2
        if sig.startswith("STRUCTURE_BREAK") and has_poc:
            out.append({**alert, "tier": 2, "suppressed_by": "POC_IN_PATH"})
            continue

        # Rule 3: VWAP_RESET + conflicting POWER_TREND direction → suppress
        if sig == "VWAP_RESET_BULL" and "POWER_TREND_BEAR" in signal_names:
            out.append({**alert, "suppressed_by": "CONFLICTING_POWER_TREND"})
            continue
        if sig == "VWAP_RESET_BEAR" and "POWER_TREND_BULL" in signal_names:
            out.append({**alert, "suppressed_by": "CONFLICTING_POWER_TREND"})
            continue

        out.append(alert)

    return out


# ── Public entry point ───────────────────────────────────────────────────────

def evaluate_composite(
    ticker: str,
    snapshot: dict,
    prev_snapshot: dict | None,
    confidence: float,
    current_price: float,
    session_fired: set[str],
    prediction_dir: str = "NEUTRAL",
) -> list[dict]:
    """
    Evaluate all composite signals for one scheduler cycle.

    Args:
        ticker         – e.g. "SPY"
        snapshot       – full indicator snapshot for this cycle
        prev_snapshot  – snapshot from the previous cycle (or None on first run)
        confidence     – AI prediction confidence (0–1)
        current_price  – latest close price
        session_fired  – signal names already emitted this session for this ticker
                         (used to enforce POWER_TREND once-per-session rule)
        prediction_dir – AI prediction direction: "UP" | "DOWN" | "NEUTRAL" | "ABSTAIN"

    Returns a (possibly empty) list of composite alert dicts.
    """
    prev = prev_snapshot or {}
    snap = {**snapshot, "price": current_price}

    candidates: list[dict] = []

    pt = _check_power_trend(ticker, snap, confidence)
    if pt and pt["signal"] not in session_fired:
        candidates.append(pt)

    sb = _check_structure_break(ticker, snap, prev, current_price, confidence)
    if sb:
        candidates.append(sb)

    vr = _check_vwap_reset(ticker, snap, prev, confidence)
    if vr:
        candidates.append(vr)

    ex = _check_exhaustion_reversal(ticker, snap, prev, current_price, confidence)
    if ex:
        candidates.append(ex)

    pm = _check_poc_magnet(ticker, snap, prev, current_price, confidence)
    if pm:
        candidates.append(pm)

    # HIGH_CONF fallback: fires when AI is confident but composite conditions aren’t met
    has_power_trend = any(c["signal"].startswith("POWER_TREND") for c in candidates)
    if not has_power_trend:
        hc = _check_high_confidence(ticker, snap, confidence, prediction_dir)
        if hc:
            candidates.append(hc)

    results = _apply_interaction_rules(candidates)
    # Tier 3 alerts are unreliable — suppress them
    return [a for a in results if a.get("tier", 1) < 3]

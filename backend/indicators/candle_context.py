"""
Candle Context Engine — analyses the last 30 minutes of 5-minute bars to
surface price structure, candlestick patterns, volume character, and pace
for the Tape Read agent.

Called after all other indicators are computed so it can reference the full
snapshot (ORB, VWAP, S/R, etc.) for level-proximity tagging.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from config import TIMEFRAMES

# ---------------------------------------------------------------------------
# Configuration — defaults match the original 2m calibration. Higher TFs
# resolve via TIMEFRAMES[tf]["candle_window_bars" / "candle_struct_bars"].
# ---------------------------------------------------------------------------
DEFAULT_WINDOW_BARS = 6      # patterns lookback
DEFAULT_STRUCT_BARS = 12     # structure / HH-HL lookback
LEVEL_PROX     = 0.003  # within 0.3% counts as "near" a key level
WICK_BODY_MULT = 1.5    # wick must be ≥ 1.5× body to qualify as rejection/hammer


# ---------------------------------------------------------------------------
# Primitive helpers
# ---------------------------------------------------------------------------
def _body(c: pd.Series) -> float:
    return abs(float(c["close"]) - float(c["open"]))

def _rng(c: pd.Series) -> float:
    return float(c["high"]) - float(c["low"])

def _upper_wick(c: pd.Series) -> float:
    return float(c["high"]) - max(float(c["open"]), float(c["close"]))

def _lower_wick(c: pd.Series) -> float:
    return min(float(c["open"]), float(c["close"])) - float(c["low"])

def _is_green(c: pd.Series) -> bool:
    return float(c["close"]) >= float(c["open"])


# ---------------------------------------------------------------------------
# ATR-14
# ---------------------------------------------------------------------------
def _atr14(df: pd.DataFrame) -> float | None:
    if len(df) < 2:
        return None
    h = df["high"].values.astype(float)
    l = df["low"].values.astype(float)
    c = df["close"].values.astype(float)
    tr = np.maximum(
        h[1:] - l[1:],
        np.maximum(np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])),
    )
    period = min(14, len(tr))
    return round(float(tr[-period:].mean()), 4)


# ---------------------------------------------------------------------------
# Pattern detection (last WINDOW_BARS candles)
# ---------------------------------------------------------------------------
def _detect_patterns(window: pd.DataFrame) -> list[str]:
    """
    Detects high-value patterns in the window DataFrame.
    Returns list of human-readable pattern name strings.
    Only patterns with at least 1 signal-quality bar are reported.
    """
    patterns: list[str] = []
    if len(window) < 2:
        return patterns

    c0 = window.iloc[-2]   # previous candle
    c1 = window.iloc[-1]   # latest candle
    b0, b1 = _body(c0), _body(c1)
    r1 = _rng(c1)

    # ── 1. Bullish Engulfing ──────────────────────────────────────────────
    if (
        not _is_green(c0) and _is_green(c1)
        and b1 > b0 * 1.05
        and float(c1["open"]) < float(c0["close"])
        and float(c1["close"]) > float(c0["open"])
    ):
        patterns.append("BullishEngulfing")

    # ── 2. Bearish Engulfing ─────────────────────────────────────────────
    if (
        _is_green(c0) and not _is_green(c1)
        and b1 > b0 * 1.05
        and float(c1["open"]) > float(c0["close"])
        and float(c1["close"]) < float(c0["open"])
    ):
        patterns.append("BearishEngulfing")

    # ── 3. Hammer / Inverted Hammer ──────────────────────────────────────
    if r1 > 0 and b1 > 0:
        lw1 = _lower_wick(c1)
        uw1 = _upper_wick(c1)
        if lw1 >= 2.0 * b1 and uw1 <= b1 * 0.5:
            patterns.append("Hammer" if _is_green(c1) else "InvertedHammer")

    # ── 4. Shooting Star ─────────────────────────────────────────────────
    if r1 > 0 and b1 > 0:
        uw1 = _upper_wick(c1)
        lw1 = _lower_wick(c1)
        if uw1 >= 2.0 * b1 and lw1 <= b1 * 0.5:
            patterns.append("ShootingStar")

    # ── 5. Doji — body ≤ 10% of range ────────────────────────────────────
    if r1 > 0 and b1 / r1 <= 0.10:
        patterns.append("Doji")

    # ── 6. Inside Bar — current entirely inside previous ─────────────────
    if (
        float(c1["high"]) < float(c0["high"])
        and float(c1["low"]) > float(c0["low"])
    ):
        patterns.append("InsideBar")

    # ── 7. NR7 — narrowest range of last 7 bars ───────────────────────────
    if len(window) >= 7:
        ranges = [_rng(window.iloc[i]) for i in range(len(window))]
        last7 = ranges[-7:]
        if ranges[-1] == min(last7) and ranges[-1] < max(last7) * 0.65:
            patterns.append("NR7")

    # ── 8. Rejection wicks ────────────────────────────────────────────────
    if r1 > 0 and b1 > 0:
        uw1 = _upper_wick(c1)
        lw1 = _lower_wick(c1)
        if not _is_green(c1) and uw1 >= WICK_BODY_MULT * b1:
            patterns.append("UpperRejectionWick")
        if _is_green(c1) and lw1 >= WICK_BODY_MULT * b1:
            patterns.append("LowerRejectionWick")

    # ── 9. Three consecutive same-color candles ───────────────────────────
    if len(window) >= 3:
        last3 = [window.iloc[-i - 1] for i in range(3)]
        if all(_is_green(c) for c in last3):
            patterns.append("ThreeGreen")
        elif all(not _is_green(c) for c in last3):
            patterns.append("ThreeRed")

    return patterns


# ---------------------------------------------------------------------------
# Structure analysis (STRUCT_BARS = 12 = last 60 min)
# ---------------------------------------------------------------------------
def _analyze_structure(sw: pd.DataFrame) -> dict[str, Any]:
    """
    Determine price structure over the STRUCT_BARS window.
    Returns: structure, hh_hl, lh_ll, body_trend, pace
    """
    result: dict[str, Any] = {
        "structure":   "CHOPPY",
        "hh_hl":       False,
        "lh_ll":       False,
        "body_trend":  "STEADY",
        "pace":        "CHOPPY",
    }
    if len(sw) < 4:
        return result

    highs  = sw["high"].values.astype(float)
    lows   = sw["low"].values.astype(float)
    bodies = [_body(sw.iloc[i]) for i in range(len(sw))]

    mid = len(highs) // 2
    first_hi  = highs[:mid].max()
    second_hi = highs[mid:].max()
    first_lo  = lows[:mid].min()
    second_lo = lows[mid:].min()

    hh_hl = bool((second_hi > first_hi) and (second_lo > first_lo))
    lh_ll = bool((second_hi < first_hi) and (second_lo < first_lo))
    result["hh_hl"] = hh_hl
    result["lh_ll"] = lh_ll

    # Coiling: recent 3-bar range much smaller than full window range
    recent_rng = highs[-3:].max() - lows[-3:].min() if len(highs) >= 3 else 0.0
    full_rng   = highs.max() - lows.min()
    coiling    = full_rng > 0 and recent_rng < full_rng * 0.35

    if coiling:
        result["structure"] = "COILING"
    elif hh_hl:
        result["structure"] = "UPTREND"
    elif lh_ll:
        result["structure"] = "DOWNTREND"
    else:
        result["structure"] = "CHOPPY"

    # Body trend: first-half avg body vs second-half avg body
    avg_first  = float(np.mean(bodies[:mid])) if mid > 0 else 0.0
    avg_second = float(np.mean(bodies[mid:])) if len(bodies) > mid else 0.0
    if avg_first > 0:
        ratio = avg_second / avg_first
        if ratio > 1.25:
            result["body_trend"] = "EXPANDING"
        elif ratio < 0.75:
            result["body_trend"] = "CONTRACTING"

    # Pace: streak of same-color candles from the end
    colors = [_is_green(sw.iloc[i]) for i in range(len(sw))]
    streak = 1
    for i in range(len(colors) - 2, -1, -1):
        if colors[i] == colors[-1]:
            streak += 1
        else:
            break
    result["pace"] = "TRENDING" if streak >= 3 else "CHOPPY"

    return result


# ---------------------------------------------------------------------------
# Volume character
# ---------------------------------------------------------------------------
def _volume_char(window: pd.DataFrame, rvol: float | None) -> str:
    if rvol is None:
        return "NORMAL"
    c1 = window.iloc[-1]
    r  = _rng(c1)
    uw = _upper_wick(c1)
    lw = _lower_wick(c1)
    long_wick = (uw > r * 0.5 or lw > r * 0.5) if r > 0 else False
    if rvol > 2.5 and long_wick:
        return "CLIMAX"
    if rvol > 1.5:
        return "INSTITUTIONAL"
    if rvol < 0.5:
        return "THIN"
    return "NORMAL"


# ---------------------------------------------------------------------------
# Last-candle close position
# ---------------------------------------------------------------------------
def _close_position(c: pd.Series) -> str:
    r = _rng(c)
    if r <= 0:
        return "MIDDLE"
    pos = (float(c["close"]) - float(c["low"])) / r
    if pos >= 0.67:
        return "UPPER"
    if pos <= 0.33:
        return "LOWER"
    return "MIDDLE"


# ---------------------------------------------------------------------------
# Nearest key-level tag
# ---------------------------------------------------------------------------
def _near_level(price: float, snapshot: dict) -> str | None:
    candidates: list[tuple[str, Any]] = [
        ("HOD",      snapshot.get("hod")),
        ("LOD",      snapshot.get("lod")),
        ("VWAP",     snapshot.get("vwap")),
        ("ORB_HIGH", snapshot.get("orb_high")),
        ("ORB_LOW",  snapshot.get("orb_low")),
        ("PDH",      snapshot.get("prev_day_high")),
        ("PDL",      snapshot.get("prev_day_low")),
        ("PM_HIGH",  snapshot.get("pm_high")),
        ("PM_LOW",   snapshot.get("pm_low")),
        ("POC",      snapshot.get("poc")),
        ("SUPP",     snapshot.get("nearest_support")),
        ("RES",      snapshot.get("nearest_resistance")),
    ]
    best_label: str | None = None
    best_dist  = LEVEL_PROX
    for label, level in candidates:
        if level is None or level <= 0:
            continue
        dist = abs(price - float(level)) / price
        if dist < best_dist:
            best_dist  = dist
            best_label = label
    return best_label


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def compute_candle_context(
    df: pd.DataFrame,
    snapshot: dict,
    current_price: float,
    tf: str | None = None,
) -> dict:
    """
    Analyse the most recent N candles of the active timeframe.

    Parameters
    ----------
    df            : Full candle DataFrame (all sessions, as-fetched).
    snapshot      : Indicator snapshot built so far (for level references).
    current_price : Latest price.
    tf            : Timeframe key (e.g. "2m", "5m", "15m"). When provided,
                    pattern / structure window sizes are read from
                    TIMEFRAMES[tf]; otherwise module defaults are used.

    Returns
    -------
    dict of new fields to be merged into the indicator snapshot.
    ``candle_patterns`` is returned as a Python list; the caller is
    responsible for JSON-serialising it before DB storage.
    """
    if tf and tf in TIMEFRAMES:
        window_bars = int(TIMEFRAMES[tf].get("candle_window_bars", DEFAULT_WINDOW_BARS))
        struct_bars = int(TIMEFRAMES[tf].get("candle_struct_bars", DEFAULT_STRUCT_BARS))
    else:
        window_bars = DEFAULT_WINDOW_BARS
        struct_bars = DEFAULT_STRUCT_BARS
    result: dict[str, Any] = {
        "hod":               None,
        "lod":               None,
        "prev_day_close":    None,
        "atr_14":            None,
        "candle_structure":  None,
        "candle_hh_hl":      None,
        "candle_lh_ll":      None,
        "candle_body_trend": None,
        "candle_pace":       None,
        "candle_vol_char":   None,
        "candle_close_pos":  None,
        "candle_near_level": None,
        "candle_patterns":   [],   # list; serialise to JSON before DB write
    }

    if df.empty:
        return result

    # ── Today's bars ──────────────────────────────────────────────────────
    if "is_today" in df.columns:
        today_df = df[df["is_today"] == True]   # noqa: E712
    else:
        today_df = df

    # ── HOD / LOD ─────────────────────────────────────────────────────────
    if not today_df.empty:
        result["hod"] = round(float(today_df["high"].max()), 4)
        result["lod"] = round(float(today_df["low"].min()),  4)

    # ── Previous-day close ────────────────────────────────────────────────
    if "is_today" in df.columns:
        prev_reg = df[(df["is_today"] == False) & (df["session"] == "regular")]  # noqa: E712
        if not prev_reg.empty:
            result["prev_day_close"] = round(float(prev_reg["close"].iloc[-1]), 4)

    # ── ATR-14 over full dataset ──────────────────────────────────────────
    result["atr_14"] = _atr14(df)

    # ── Limit analysis to regular-session bars from today ─────────────────
    reg_today = today_df[today_df["session"] == "regular"] if not today_df.empty else pd.DataFrame()
    if reg_today.empty:
        reg_today = today_df   # fallback to all today bars (pre-market only)
    if reg_today.empty:
        reg_today = df         # ultimate fallback

    window  = reg_today.tail(window_bars).reset_index(drop=True)
    sw_data = reg_today.tail(struct_bars).reset_index(drop=True)

    if len(window) < 2:
        return result

    # ── Pattern detection ─────────────────────────────────────────────────
    result["candle_patterns"] = _detect_patterns(window)

    # ── Structure, body trend, pace ───────────────────────────────────────
    sd = _analyze_structure(sw_data)
    result["candle_structure"]  = sd["structure"]
    result["candle_hh_hl"]      = sd["hh_hl"]
    result["candle_lh_ll"]      = sd["lh_ll"]
    result["candle_body_trend"] = sd["body_trend"]
    result["candle_pace"]       = sd["pace"]

    # ── Volume character ──────────────────────────────────────────────────
    result["candle_vol_char"] = _volume_char(window, snapshot.get("rvol"))

    # ── Close position of the latest candle ───────────────────────────────
    result["candle_close_pos"] = _close_position(window.iloc[-1])

    # ── Nearest level (merge hod/lod into snapshot first) ─────────────────
    merged_snap = {**snapshot, **result}
    result["candle_near_level"] = _near_level(current_price, merged_snap)

    return result

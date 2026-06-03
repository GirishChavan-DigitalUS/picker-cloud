"""
Session-level price levels derived from intraday 5-minute bars.

Computes:
  - Premarket high / low  (4:00–9:30 ET)
  - 15-minute Opening Range Breakout high / low  (first 3 × 5-min bars of regular)
  - Previous regular session high / low
  - Per-session Point of Control  (premarket / regular / after-hours)
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from config import ET

_NUM_BINS = 50


def _poc_for(session_df: pd.DataFrame) -> float | None:
    """Return the POC price for a set of candle rows, or None if empty/zero-vol."""
    if session_df.empty or session_df["volume"].sum() == 0:
        return None
    lo = float(session_df["low"].min())
    hi = float(session_df["high"].max())
    if lo >= hi:
        return round(float(session_df["close"].iloc[-1]), 4)
    bins = np.linspace(lo, hi, _NUM_BINS + 1)
    vol = np.zeros(_NUM_BINS)
    for _, row in session_df.iterrows():
        bar_bins = np.where((bins[:-1] <= row["high"]) & (bins[1:] >= row["low"]))[0]
        if len(bar_bins):
            vol[bar_bins] += row["volume"] / len(bar_bins)
    idx = int(np.argmax(vol))
    return round((bins[idx] + bins[idx + 1]) / 2.0, 4)


def compute_session_levels(df: pd.DataFrame) -> dict:
    """
    df must have columns: timestamp (ISO-8601 UTC str), open, high, low,
    close, volume, session ('pre'|'regular'|'after'|'closed').

    All data is assumed to be from the *most-recent trading day* (already
    filtered upstream in the yfinance fetcher).

    Returns a dict with keys:
        pm_high, pm_low,
        orb_high, orb_low,
        prev_day_high, prev_day_low,
        poc_pre, poc_regular, poc_after
    """
    result: dict = {
        "pm_high": None, "pm_low": None,
        "orb_high": None, "orb_low": None,
        "prev_day_high": None, "prev_day_low": None,
        "poc_pre": None, "poc_regular": None, "poc_after": None,
    }

    if df.empty:
        return result

    # ---- Premarket (session == 'pre') --------------------------------
    pre_df = df[df["session"] == "pre"]
    if not pre_df.empty:
        result["pm_high"] = round(float(pre_df["high"].max()), 4)
        result["pm_low"]  = round(float(pre_df["low"].min()), 4)
        result["poc_pre"] = _poc_for(pre_df)

    # ---- Regular session ORB (9:30–9:44 ET = first 15 min) -----------
    # Use today's bars only — the df also contains yesterday's regular session
    # bars (for prev-day H/L), so head(3) without is_today would pick yesterday.
    if "is_today" in df.columns:
        today_reg = df[(df["session"] == "regular") & (df["is_today"] == True)]  # noqa: E712
    else:
        today_reg = df[df["session"] == "regular"]

    if not today_reg.empty:
        # Explicitly filter to 9:30–9:44 ET (the 3 bars that define the ORB)
        try:
            ts_et = pd.to_datetime(today_reg["timestamp"], utc=True).dt.tz_convert(ET)
            orb_mask = (ts_et.dt.hour == 9) & (ts_et.dt.minute < 45)
            orb_df = today_reg[orb_mask.values]
            if orb_df.empty:
                # Market hasn't opened yet or no data in window — use first 3 bars
                orb_df = today_reg.head(3)
        except Exception:
            orb_df = today_reg.head(3)

        result["orb_high"] = round(float(orb_df["high"].max()), 4)
        result["orb_low"]  = round(float(orb_df["low"].min()), 4)
        result["poc_regular"] = _poc_for(today_reg)

    # ---- After-hours -------------------------------------------------
    after_df = df[df["session"] == "after"]
    result["poc_after"] = _poc_for(after_df)

    # ---- Previous regular session H/L --------------------------------
    # df may include yesterday's regular session rows (is_today == False)
    if "is_today" in df.columns:
        prev_reg = df[(df["is_today"] == False) & (df["session"] == "regular")]  # noqa: E712
    else:
        # Fallback: find rows before the first today-regular bar by integer index
        reg_indices = df.index[df["session"] == "regular"].tolist()
        today_reg_start = reg_indices[0] if reg_indices else None
        prev_reg = df.loc[:today_reg_start - 1][
            df.loc[:today_reg_start - 1, "session"] == "regular"
        ] if today_reg_start and today_reg_start > 0 else pd.DataFrame()

    if not prev_reg.empty:
        result["prev_day_high"] = round(float(prev_reg["high"].max()), 4)
        result["prev_day_low"]  = round(float(prev_reg["low"].min()), 4)

    return result

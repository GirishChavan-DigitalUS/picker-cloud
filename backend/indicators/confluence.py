"""
Confluence scoring module.

Synthesises indicator snapshot fields into bull/bear alignment scores.
Each aligned signal adds 1 point to the matching side.
Maximum possible score: 9 points per side (no double-counting).

Scored signals (9 items, each contributes max 1 point):
  1. EMA alignment (mutually exclusive): full stack (9>21>50) OR simple cross —
     never both; prevents the old +2 double-count from a single EMA observation.
  2. VWAP position/momentum (mutually exclusive tiered):
     — ABOVE+AWAY or BELOW+AWAY counts as 1 (active momentum tier)
     — ABOVE or BELOW without AWAY also counts as 1 (static tier)
     — never both; prevents old +2 double-count.
  3. Daily trend (BULL / BEAR)
  4. RSI vs 50 midline (> 50 bullish / < 50 bearish)
  5. Price vs POC (above / below)
  6. Price vs ORB high (above = bullish breakout ONLY — being below ORB is
     not inherently bearish, it simply means no breakout yet)
  7. RVOL conviction (high volume on trend bar)
  8. Swing structure (candle_hh_hl = confirmed HH+HL = bullish;
     candle_lh_ll = confirmed LH+LL = bearish)
  9. VWAP slope direction (rising VWAP = bullish context; falling = bearish)
"""
from __future__ import annotations


def compute_confluence(snapshot: dict, current_price: float) -> dict:
    """
    Args:
        snapshot      – indicator snapshot dict (same keys stored in DB)
        current_price – latest close price

    Returns:
        bull_score      int  – 0–9 bullish signals aligned
        bear_score      int  – 0–9 bearish signals aligned
        confluence_bias str  – BULL | BEAR | MIXED
    """
    bull = 0
    bear = 0

    # 1. EMA alignment (mutually exclusive: full stack OR simple cross, never both)
    e9  = snapshot.get("ema9")
    e21 = snapshot.get("ema21")
    e50 = snapshot.get("ema50")
    ema_state = snapshot.get("ema_state")
    if e9 is not None and e21 is not None and e50 is not None:
        if e9 > e21 > e50:
            bull += 1      # full stack — use stack signal, not simple cross
        elif e9 < e21 < e50:
            bear += 1      # full bear stack
        elif ema_state == "BULLISH":
            bull += 1      # partial cross only (EMA9 > EMA21, not full stack)
        elif ema_state == "BEARISH":
            bear += 1
    elif ema_state == "BULLISH":
        bull += 1
    elif ema_state == "BEARISH":
        bear += 1

    # 2. VWAP position/momentum (mutually exclusive tiers, 1 pt max from VWAP)
    pvwap  = snapshot.get("price_vs_vwap")
    motion = snapshot.get("vwap_motion")
    if pvwap == "ABOVE":
        bull += 1  # both active (AWAY) and static (not AWAY) count the same here
    elif pvwap == "BELOW":
        bear += 1
    # Note: we intentionally don't add a second point for AWAY — that was the
    # double-count. The rule_engine's tiered weights handle the distinction.

    # 3. Daily trend
    daily = snapshot.get("daily_trend")
    if daily == "BULL":
        bull += 1
    elif daily == "BEAR":
        bear += 1

    # 4. RSI vs 50 midline
    rsi = snapshot.get("rsi_14")
    if rsi is not None:
        if rsi > 50:
            bull += 1
        elif rsi < 50:
            bear += 1

    # 5. Price vs POC
    poc = snapshot.get("poc")
    if poc and current_price:
        if current_price > poc:
            bull += 1
        elif current_price < poc:
            bear += 1

    # 6. Price vs ORB high (above = bullish breakout; below = no breakout yet,
    #    NOT inherently bearish — remove the old bidirectional scoring)
    orb_high = snapshot.get("orb_high")
    if orb_high and current_price:
        if current_price > orb_high:
            bull += 1
        # Do NOT add bear point for being below ORB — that was a false signal

    # 7. RVOL conviction (high volume on directional bar)
    rvol       = snapshot.get("rvol")
    recent_ret = snapshot.get("recent_return_5m")
    if rvol is not None and recent_ret is not None and rvol > 1.5:
        if recent_ret > 0:
            bull += 1
        elif recent_ret < 0:
            bear += 1

    # 8. Swing structure confirmation (multi-bar HH+HL or LH+LL pattern)
    if snapshot.get("candle_hh_hl"):
        bull += 1
    if snapshot.get("candle_lh_ll"):
        bear += 1

    # 9. VWAP slope direction (is VWAP itself trending up or down?)
    vwap_slope = snapshot.get("vwap_slope")
    if vwap_slope is not None:
        if vwap_slope > 0:
            bull += 1
        elif vwap_slope < 0:
            bear += 1

    if bull > bear:
        bias = "BULL"
    elif bear > bull:
        bias = "BEAR"
    else:
        bias = "MIXED"

    return {
        "bull_score":      bull,
        "bear_score":      bear,
        "confluence_bias": bias,
    }

"""
Deterministic rule-based AI engine.

All rules use ONLY the computed indicator feature set — no external data,
no news, no free-form inference. Each rule appends a named trigger string.
Confidence = weighted_votes_majority / total_weighted_votes.
Mixed or low-confidence results return ABSTAIN.

Design principles (v4):
  - EMA rules are mutually exclusive: simple cross fires only when full stack
    does NOT apply (prevents 2.7-weight double-count).
  - VWAP rules are tiered and mutually exclusive: static position (0.7) vs
    active momentum AWAY (1.3) — never both simultaneously.
  - VWAP convergence gated on >1% deviation to suppress normal noise.
  - RSI overbought/oversold require price-action confirmation and are
    suppressed when EMA stack confirms the opposite direction.
  - EMA cross imminent is a CONFIDENCE SUPPRESSOR (×0.7), not a scored rule.
  - Time-of-day multiplier scales final confidence by session phase.
  - ORB breakout/breakdown added as primary high-weight signals.
  - Support bounce and ORB hold tightened with volume gates.
  - Swing structure rules require confirmed multi-bar pattern (candle_hh_hl/lh_ll).
  - volume_dry_up has directional trigger names for clear auditing.
  - Confluence moderate tier added (score ≥ 4).
"""
from __future__ import annotations

import math

from config import ABSTAIN_CONFIDENCE_THRESHOLD
from ai.schemas import EvidenceFields, PredictionOutput


# ---------------------------------------------------------------------------
# Multi-timeframe threshold scaling (Phase 2)
# ---------------------------------------------------------------------------
# Time-dependent thresholds (return/slope/spread per bar) scale with sqrt(time)
# because per-bar volatility scales with sqrt(bar_minutes) under a Brownian
# assumption. Baseline TF = 2m, so scale = sqrt(bar_minutes / 2).
#
# Distance-from-level thresholds (% of price) and volume-ratio thresholds are
# TF-independent (price proximity / normalised volume) and stay unscaled.
_BASE_BAR_MINUTES = 2.0

def _tf_scale(ev: EvidenceFields) -> float:
    """Return the sqrt-time scale factor for momentum/slope thresholds.
    Falls back to 1.0 (2m baseline) when bar_minutes is unknown."""
    if ev.bar_minutes is None or ev.bar_minutes <= 0:
        return 1.0
    return math.sqrt(ev.bar_minutes / _BASE_BAR_MINUTES)


# ── EMA rules (mutually exclusive) ──────────────────────────────────────────

def _rule_ema(ev: EvidenceFields) -> tuple[str, str] | None:
    """Simple EMA9 > EMA21 cross — only fires when full EMA stack does NOT apply.
    Weight 1.0 (was 1.5). Full stack handled exclusively by _rule_ema_stack."""
    if ev.ema_state is None or ev.ema9 is None or ev.ema21 is None or ev.ema50 is None:
        return None
    # Mutual exclusion: yield to stack rule when all three are aligned
    if ev.ema9 > ev.ema21 > ev.ema50 or ev.ema9 < ev.ema21 < ev.ema50:
        return None
    if ev.ema_state == "BULLISH":
        return ("UP", "ema_bullish")
    return ("DOWN", "ema_bearish")


def _rule_ema_stack(ev: EvidenceFields) -> tuple[str, str] | None:
    """Full EMA stack: ema9 > ema21 > ema50 — strongest trend structure. Weight 1.2."""
    if ev.ema9 is None or ev.ema21 is None or ev.ema50 is None:
        return None
    if ev.ema9 > ev.ema21 > ev.ema50:
        return ("UP", "ema_stack_bullish")
    if ev.ema9 < ev.ema21 < ev.ema50:
        return ("DOWN", "ema_stack_bearish")
    return None


# ── VWAP rules (tiered, mutually exclusive per tier) ────────────────────────

def _rule_vwap_static(ev: EvidenceFields) -> tuple[str, str] | None:
    """Price positioned above/below VWAP with no active AWAY motion.
    Low-weight context signal (0.7). Superseded by _rule_vwap_momentum when AWAY fires."""
    if ev.price_vs_vwap is None or ev.vwap_motion is None:
        return None
    if ev.vwap_motion == "AWAY":
        return None  # momentum rule owns this tier
    if ev.price_vs_vwap == "ABOVE":
        return ("UP", "price_above_vwap")
    return ("DOWN", "price_below_vwap")


def _rule_vwap_momentum(ev: EvidenceFields) -> tuple[str, str] | None:
    """Price positioned AND actively moving AWAY from VWAP — high conviction.
    Weight 1.3. Replaces both static position and motion rules when AWAY fires."""
    if ev.price_vs_vwap is None or ev.vwap_motion != "AWAY":
        return None
    if ev.price_vs_vwap == "ABOVE":
        return ("UP", "vwap_bull_momentum")
    return ("DOWN", "vwap_bear_momentum")


def _rule_vwap_converging(ev: EvidenceFields) -> tuple[str, str] | None:
    """Price converging TOWARD VWAP from an extended position (>1% deviation).
    Gated on distance to suppress noise within normal range. Weight 1.1."""
    if ev.price_vs_vwap is None or ev.vwap_motion != "TOWARD":
        return None
    dist = abs(ev.vwap_distance_pct or 0.0)
    if dist < 1.0:
        return None  # within 1% of VWAP — not meaningfully extended
    if ev.price_vs_vwap == "ABOVE":
        return ("DOWN", "vwap_converging_from_above")
    return ("UP", "vwap_converging_from_below")


def _rule_vwap_cross(ev: EvidenceFields) -> tuple[str, str] | None:
    """VWAP reclaim (cross above) or lose (cross below) — state-change event. Weight 1.3."""
    if ev.vwap_cross_dir is None:
        return None
    if ev.vwap_cross_dir == "RECLAIM":
        return ("UP", "vwap_reclaim_bullish")
    return ("DOWN", "vwap_lose_bearish")


# ── Trend / structure ────────────────────────────────────────────────────────

def _rule_daily_trend(ev: EvidenceFields) -> tuple[str, str] | None:
    if ev.daily_trend is None or ev.daily_trend == "NEUTRAL":
        return None
    if ev.daily_trend == "BULL":
        return ("UP", "daily_trend_bull")
    return ("DOWN", "daily_trend_bear")


def _rule_higher_low(ev: EvidenceFields) -> tuple[str, str] | None:
    """Confirmed bullish swing structure (HH+HL on multiple bars).
    Gated on candle_hh_hl from candle_context — requires 2+ consecutive swing points.
    Weight 1.1 (was 0.9 on single-bar; higher-quality gate warrants more weight)."""
    if not ev.candle_hh_hl:
        return None
    return ("UP", "higher_low_formed")


def _rule_lower_high(ev: EvidenceFields) -> tuple[str, str] | None:
    """Confirmed bearish swing structure (LH+LL on multiple bars).
    Gated on candle_lh_ll. Weight 1.1."""
    if not ev.candle_lh_ll:
        return None
    return ("DOWN", "lower_high_formed")


# ── S/R levels ───────────────────────────────────────────────────────────────

def _rule_price_vs_poc(ev: EvidenceFields) -> tuple[str, str] | None:
    if ev.poc is None or ev.price is None:
        return None
    if ev.price > ev.poc:
        return ("UP", "price_above_poc")
    return ("DOWN", "price_below_poc")


def _rule_price_vs_support(ev: EvidenceFields) -> tuple[str, str] | None:
    if ev.nearest_support is None or ev.price is None:
        return None
    gap_pct = (ev.price - ev.nearest_support) / ev.nearest_support
    if 0 < gap_pct < 0.003:
        return ("UP", "price_near_support")
    return None


def _rule_price_vs_resistance(ev: EvidenceFields) -> tuple[str, str] | None:
    if ev.nearest_resistance is None or ev.price is None:
        return None
    gap_pct = (ev.nearest_resistance - ev.price) / ev.price
    if 0 < gap_pct < 0.003:
        return ("DOWN", "price_near_resistance")
    return None


def _rule_sr_support_bounce(ev: EvidenceFields) -> tuple[str, str] | None:
    """Support bounce: price within 0.2% above support, moving up, volume confirms.
    Added gates: volume ≥ 0.8× avg (not a dry drift) + upward momentum required.
    Weight raised 0.8 → 1.2 with tighter conditions."""
    if ev.nearest_support is None or ev.price is None or ev.recent_return_5m is None:
        return None
    gap_pct = (ev.price - ev.nearest_support) / ev.nearest_support
    if not (0 <= gap_pct < 0.002):
        return None
    if ev.recent_return_5m <= 0:
        return None
    # Volume must not be dry — a low-volume drift into support is not a bounce
    if ev.volume_ratio is not None and ev.volume_ratio < 0.8:
        return None
    return ("UP", "sr_support_bounce")


# ── ORB rules ────────────────────────────────────────────────────────────────

def _rule_orb_hold(ev: EvidenceFields) -> tuple[str, str] | None:
    """Pullback to ORB high that holds with DRY volume — weak sellers, bull continuation.
    Added gate: volume < 0.8× avg (dry pullback confirms no distribution).
    Weight raised 0.7 → 1.1."""
    if ev.orb_high is None or ev.price is None:
        return None
    gap_pct = (ev.price - ev.orb_high) / ev.orb_high
    if not (0 <= gap_pct < 0.002):
        return None
    # Dry pullback required — sellers must be absent
    if ev.volume_ratio is not None and ev.volume_ratio >= 0.8:
        return None
    return ("UP", "opening_range_hold")


def _rule_orb_breakout_bull(ev: EvidenceFields) -> tuple[str, str] | None:
    """Price closes ABOVE ORB high with volume confirmation — primary breakout signal.
    Weight 1.6. TOD multiplier naturally suppresses after 11:30."""
    if ev.orb_high is None or ev.price is None:
        return None
    if ev.price <= ev.orb_high:
        return None
    if ev.volume_ratio is None or ev.volume_ratio < 1.3:
        return None
    return ("UP", "orb_breakout_bull")


def _rule_orb_breakdown_bear(ev: EvidenceFields) -> tuple[str, str] | None:
    """Price closes BELOW ORB low with volume confirmation — primary breakdown signal.
    Weight 1.6."""
    if ev.orb_low is None or ev.price is None:
        return None
    if ev.price >= ev.orb_low:
        return None
    if ev.volume_ratio is None or ev.volume_ratio < 1.3:
        return None
    return ("DOWN", "orb_breakdown_bear")


# ── Momentum / volume ────────────────────────────────────────────────────────

def _rule_momentum(ev: EvidenceFields) -> tuple[str, str] | None:
    """3-bar slope preferred over single-bar return — smoother, less spike-sensitive.
    Base thresholds (2m calibration): slope_3bar ±0.15%, single-bar return ±0.3%.
    Scaled by sqrt(bar_minutes / 2) for the active timeframe."""
    scale = _tf_scale(ev)
    slope_thr = 0.0015 * scale
    bar_thr   = 0.003  * scale
    if ev.slope_3bar is not None:
        if ev.slope_3bar >  slope_thr:
            return ("UP",   "positive_momentum")
        if ev.slope_3bar < -slope_thr:
            return ("DOWN", "negative_momentum")
        return None
    # Fallback: single-bar return
    if ev.recent_return_5m is None:
        return None
    if ev.recent_return_5m >  bar_thr:
        return ("UP",   "positive_momentum")
    if ev.recent_return_5m < -bar_thr:
        return ("DOWN", "negative_momentum")
    return None


def _rule_volume_surge(ev: EvidenceFields) -> tuple[str, str] | None:
    """Volume > 1.5× avg with directional price move — institutional conviction."""
    if ev.volume_ratio is None or ev.recent_return_5m is None:
        return None
    if ev.volume_ratio > 1.5:
        if ev.recent_return_5m > 0:
            return ("UP", "volume_surge_up")
        if ev.recent_return_5m < 0:
            return ("DOWN", "volume_surge_down")
    return None


def _rule_volume_dry_up(ev: EvidenceFields) -> tuple[str, str] | None:
    """Volume < 0.5× avg on a counter-trend bar — trend likely to resume.
    Directional trigger names: pullback (bull trend dip) vs bounce (bear trend pop)."""
    if ev.volume_ratio is None or ev.recent_return_5m is None or ev.daily_trend is None:
        return None
    if ev.volume_ratio < 0.5:
        if ev.daily_trend == "BULL" and ev.recent_return_5m < 0:
            return ("UP", "volume_dry_up_pullback")
        if ev.daily_trend == "BEAR" and ev.recent_return_5m > 0:
            return ("DOWN", "volume_dry_up_bounce")
    return None


# ── RSI (gated to prevent trend-fighting) ────────────────────────────────────

def _rule_rsi_overbought(ev: EvidenceFields) -> tuple[str, str] | None:
    """RSI > 70 bearish signal — suppressed when EMA stack is bullish (RSI in
    uptrend = momentum confirmation, not reversal). Requires actual price rejection
    (return < 0 on this bar) to confirm real topping action."""
    if ev.rsi_14 is None or ev.rsi_14 <= 70:
        return None
    # Suppress when confirmed bull EMA stack — RSI > 70 in a trend is normal
    if ev.ema9 is not None and ev.ema21 is not None and ev.ema50 is not None:
        if ev.ema9 > ev.ema21 > ev.ema50:
            return None
    # Require price to actually be falling on this bar
    if ev.recent_return_5m is None or ev.recent_return_5m >= 0:
        return None
    return ("DOWN", "rsi_overbought")


def _rule_rsi_oversold(ev: EvidenceFields) -> tuple[str, str] | None:
    """RSI < 30 bullish signal — suppressed when EMA stack is bearish.
    Requires actual upward price confirmation on this bar."""
    if ev.rsi_14 is None or ev.rsi_14 >= 30:
        return None
    # Suppress when confirmed bear EMA stack
    if ev.ema9 is not None and ev.ema21 is not None and ev.ema50 is not None:
        if ev.ema9 < ev.ema21 < ev.ema50:
            return None
    # Require price to actually be rising on this bar
    if ev.recent_return_5m is None or ev.recent_return_5m <= 0:
        return None
    return ("UP", "rsi_oversold")


# ── EMA cross imminent — CONFIDENCE SUPPRESSOR (not a scored rule) ───────────

def _ema_cross_suppressor(ev: EvidenceFields) -> float:
    """Returns a confidence multiplier < 1.0 when EMA9 and EMA21 are converging.
    Applied after computing raw confidence — reduces signal strength near crosses.
    A tightening spread means the current direction is weakening, not accelerating."""
    if ev.ema_spread_pct is None:
        return 1.0
    if abs(ev.ema_spread_pct) < 0.08:
        return 0.7  # suppress 30% — signal is weakening
    return 1.0


# ── Time-of-day confidence multiplier ────────────────────────────────────────

def _time_of_day_multiplier(bar_time_et: str | None) -> float:
    """Scale final confidence by intraday session phase.
      09:30–10:00 ×1.3  open momentum — most reliable
      10:00–11:30 ×1.0  base rate
      11:30–13:30 ×0.6  lunch chop — suppress weak signals
      13:30–15:00 ×1.0  afternoon trend resumes
      15:00–16:00 ×1.2  power hour — volume returns
    Applied to raw confidence before threshold check so ABSTAIN fires naturally
    during suppressed periods without hard-coding special cases."""
    if not bar_time_et:
        return 1.0
    t = bar_time_et[:5]
    if   "09:30" <= t < "10:00": return 1.3
    elif "10:00" <= t < "11:30": return 1.0
    elif "11:30" <= t < "13:30": return 0.6
    elif "13:30" <= t < "15:00": return 1.0
    elif "15:00" <= t < "16:00": return 1.2
    return 1.0


# ── Confluence meta-signals ───────────────────────────────────────────────────

def _rule_confluence_moderate_bull(ev: EvidenceFields) -> tuple[str, str] | None:
    """Moderate multi-indicator alignment: bull_score 4–5. Weight 1.3.
    Fires for genuine but not peak-confluence setups — allows earlier entries."""
    if ev.bull_score is None or ev.bull_score < 4 or ev.bull_score >= 6:
        return None
    return ("UP", "confluence_moderate_bull")


def _rule_confluence_moderate_bear(ev: EvidenceFields) -> tuple[str, str] | None:
    """Moderate multi-indicator alignment: bear_score 4–5. Weight 1.3."""
    if ev.bear_score is None or ev.bear_score < 4 or ev.bear_score >= 6:
        return None
    return ("DOWN", "confluence_moderate_bear")


def _rule_confluence_strong_bull(ev: EvidenceFields) -> tuple[str, str] | None:
    """Strong multi-indicator alignment: bull_score >= 6. Weight 1.8.
    With double-counting fixed, reaching 6 now requires genuinely independent signals."""
    if ev.bull_score is None or ev.bull_score < 6:
        return None
    return ("UP", "confluence_strong_bull")


def _rule_confluence_strong_bear(ev: EvidenceFields) -> tuple[str, str] | None:
    """Strong multi-indicator alignment: bear_score >= 6. Weight 1.8."""
    if ev.bear_score is None or ev.bear_score < 6:
        return None
    return ("DOWN", "confluence_strong_bear")


# ── Rule registry ─────────────────────────────────────────────────────────────

_RULES = [
    # EMA (mutually exclusive — stack supersedes simple cross)
    _rule_ema,
    _rule_ema_stack,
    # VWAP (tiered tiers — static, momentum, converging, cross-event)
    _rule_vwap_static,
    _rule_vwap_momentum,
    _rule_vwap_converging,
    _rule_vwap_cross,
    # Trend / structure
    _rule_daily_trend,
    _rule_higher_low,
    _rule_lower_high,
    # S/R levels
    _rule_price_vs_poc,
    _rule_price_vs_support,
    _rule_price_vs_resistance,
    _rule_sr_support_bounce,
    # ORB
    _rule_orb_hold,
    _rule_orb_breakout_bull,
    _rule_orb_breakdown_bear,
    # Momentum / volume
    _rule_momentum,
    _rule_volume_surge,
    _rule_volume_dry_up,
    # RSI (gated)
    _rule_rsi_overbought,
    _rule_rsi_oversold,
    # Confluence meta (EMA cross imminent removed — now a suppressor)
    _rule_confluence_moderate_bull,
    _rule_confluence_moderate_bear,
    _rule_confluence_strong_bull,
    _rule_confluence_strong_bear,
]

_RULE_WEIGHTS: dict[str, float] = {
    # EMA — weight reduced; stack unchanged
    "ema_bullish":              1.0,   # was 1.5; only partial cross now
    "ema_bearish":              1.0,
    "ema_stack_bullish":        1.2,
    "ema_stack_bearish":        1.2,
    # VWAP — tiered weights prevent double-counting
    "price_above_vwap":         0.7,   # static context only
    "price_below_vwap":         0.7,
    "vwap_bull_momentum":       1.3,   # active AWAY — high conviction
    "vwap_bear_momentum":       1.3,
    "vwap_converging_from_above": 1.1, # extended + converging
    "vwap_converging_from_below": 1.1,
    "vwap_reclaim_bullish":     1.3,
    "vwap_lose_bearish":        1.3,
    # Trend / structure
    "daily_trend_bull":         1.2,
    "daily_trend_bear":         1.2,
    "higher_low_formed":        1.1,   # was 0.9; now gated on confirmed structure
    "lower_high_formed":        1.1,
    # S/R
    "sr_support_bounce":        1.2,   # was 0.8; tightened conditions justify raise
    # ORB
    "opening_range_hold":       1.1,   # was 0.7; dry-pullback gate raises quality
    "orb_breakout_bull":        1.6,
    "orb_breakdown_bear":       1.6,
    # Momentum / volume
    "positive_momentum":        1.0,
    "negative_momentum":        1.0,
    "volume_surge_up":          1.1,
    "volume_surge_down":        1.1,
    "volume_dry_up_pullback":   0.7,   # was 0.6 as undifferentiated "volume_dry_up"
    "volume_dry_up_bounce":     0.7,
    # RSI (gated — weight unchanged; quality improved via gates)
    "rsi_overbought":           0.9,
    "rsi_oversold":             0.9,
    # Confluence
    "confluence_moderate_bull": 1.3,
    "confluence_moderate_bear": 1.3,
    "confluence_strong_bull":   1.8,
    "confluence_strong_bear":   1.8,
}


def evaluate(ticker: str, evidence: EvidenceFields) -> PredictionOutput:
    """
    Run all rules against the evidence and produce a PredictionOutput.
    Uses ONLY the fields in evidence — no external data.
    Post-processing:
      1. EMA cross imminent suppressor (×0.7 when spread < 0.08%)
      2. Time-of-day multiplier (scales confidence by session phase)
    """
    votes_up: float = 0.0
    votes_down: float = 0.0
    rules_triggered: list[str] = []

    for rule_fn in _RULES:
        result = rule_fn(evidence)
        if result is None:
            continue
        direction, trigger = result
        weight = _RULE_WEIGHTS.get(trigger, 1.0)
        rules_triggered.append(trigger)
        if direction == "UP":
            votes_up += weight
        else:
            votes_down += weight

    total = votes_up + votes_down
    if total == 0:
        return PredictionOutput(
            ticker=ticker,
            prediction="ABSTAIN",
            confidence=0.0,
            evidence=evidence,
            rules_triggered=[],
            notes="no_rules_fired",
        )

    if votes_up > votes_down:
        raw_conf = votes_up / total
        dominant = "UP"
    elif votes_down > votes_up:
        raw_conf = votes_down / total
        dominant = "DOWN"
    else:
        raw_conf = 0.5
        dominant = None

    # EMA cross imminent suppressor — weakens signal near a crossover
    raw_conf *= _ema_cross_suppressor(evidence)

    # Time-of-day multiplier — suppresses weak signals during lunch chop,
    # amplifies signals during open momentum and power hour
    raw_conf = min(1.0, raw_conf * _time_of_day_multiplier(evidence.bar_time_et))

    if dominant == "UP":
        prediction = "UP" if raw_conf >= ABSTAIN_CONFIDENCE_THRESHOLD else "NEUTRAL"
    elif dominant == "DOWN":
        prediction = "DOWN" if raw_conf >= ABSTAIN_CONFIDENCE_THRESHOLD else "NEUTRAL"
    else:
        raw_conf = 0.5
        prediction = "NEUTRAL"

    if raw_conf < ABSTAIN_CONFIDENCE_THRESHOLD:
        prediction = "ABSTAIN"

    return PredictionOutput(
        ticker=ticker,
        prediction=prediction,
        confidence=round(raw_conf, 4),
        evidence=evidence,
        rules_triggered=rules_triggered,
    )


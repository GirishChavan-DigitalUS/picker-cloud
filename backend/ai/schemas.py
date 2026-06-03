"""
Pydantic models for the AI prediction JSON contract.

The AI evaluator MUST only produce output conforming to PredictionOutput.
No hallucination: all fields in evidence must come directly from computed indicators.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class EvidenceFields(BaseModel):
    ema9: float | None = None
    ema21: float | None = None
    ema50: float | None = None
    ema_state: Literal["BULLISH", "BEARISH"] | None = None
    vwap: float | None = None
    price: float | None = None
    price_vs_vwap: Literal["ABOVE", "BELOW"] | None = None
    vwap_distance_pct: float | None = None
    vwap_motion: Literal["TOWARD", "AWAY", "FLAT"] | None = None
    vwap_cross_dir: Literal["RECLAIM", "LOSE"] | None = None
    daily_trend: Literal["BULL", "BEAR", "NEUTRAL"] | None = None
    poc: float | None = None
    nearest_support: float | None = None
    nearest_resistance: float | None = None
    last_swing_high: float | None = None
    last_swing_low: float | None = None
    recent_return_5m: float | None = None
    recent_volatility: float | None = None
    volume_ratio: float | None = None       # current_volume / 20-bar avg volume
    candle_higher_low: bool | None = None   # curr_low > prev_low on a pullback bar
    candle_lower_high: bool | None = None   # curr_high < prev_high on a bounce bar
    orb_high: float | None = None
    # v3 additions
    rsi_14: float | None = None             # RSI-14 (Wilder smoothing)
    rsi_state: Literal["OVERBOUGHT", "OVERSOLD", "NEUTRAL"] | None = None
    ema_spread_pct: float | None = None     # (ema9 - ema21) / ema21 * 100
    bull_score: int | None = None           # confluence bull count (0–9)
    bear_score: int | None = None           # confluence bear count (0–9)
    confluence_bias: Literal["BULL", "BEAR", "MIXED"] | None = None
    # v4 additions
    orb_low: float | None = None            # opening range low
    candle_hh_hl: bool | None = None        # confirmed HH+HL swing structure (bullish)
    candle_lh_ll: bool | None = None        # confirmed LH+LL swing structure (bearish)
    bar_time_et: str | None = None          # "HH:MM" ET of last closed bar (for TOD multiplier)
    slope_3bar: float | None = None         # 3-bar price slope — smoother than single-bar return
    # multi-timeframe context (Phase 2)
    tf: str | None = None                   # active timeframe key: "2m" | "5m" | "15m"
    bar_minutes: int | None = None          # nominal minutes per bar — drives threshold scaling


class PredictionOutput(BaseModel):
    ticker: str
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    horizon: str = "next_1_to_3_5m_candles"
    prediction: Literal["UP", "DOWN", "NEUTRAL", "ABSTAIN"]
    confidence: float = Field(ge=0.0, le=1.0)
    evidence: EvidenceFields
    rules_triggered: list[str] = Field(default_factory=list)
    notes: str | None = None

    @field_validator("confidence")
    @classmethod
    def round_confidence(cls, v: float) -> float:
        return round(v, 4)

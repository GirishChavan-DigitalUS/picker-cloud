"""
AI Evaluator — orchestrates rule engine + optional ML, logs predictions,
and resolves outcomes for accuracy tracking.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import pandas as pd

from ai.schemas import EvidenceFields, PredictionOutput
from ai.rule_engine import evaluate as rule_evaluate
from ai.ml_model import ml_registry
from config import ABSTAIN_CONFIDENCE_THRESHOLD, PREDICTION_HORIZON_BARS, ET, TIMEFRAMES, PRIMARY_TIMEFRAME
import db

logger = logging.getLogger(__name__)


async def build_evidence(
    ticker: str,
    df: pd.DataFrame,
    current_price: float,
    indicator_row: dict,
    tf: str = PRIMARY_TIMEFRAME,
) -> EvidenceFields:
    """Assemble an EvidenceFields from a fresh indicator snapshot.

    `tf` is the active timeframe — carried through to the rule engine so
    momentum/slope thresholds scale appropriately for the bar duration.
    """
    closes = df["close"].astype(float)
    recent_return = float((closes.iloc[-1] - closes.iloc[-2]) / closes.iloc[-2]) if len(closes) >= 2 else 0.0
    volatility = float(closes.pct_change().dropna().tail(20).std()) if len(closes) >= 5 else 0.0

    # 3-bar slope: (close[-1] - close[-3]) / close[-3] — smoother directional signal
    slope_3bar: float | None = None
    if len(closes) >= 3:
        slope_3bar = round(float((closes.iloc[-1] - closes.iloc[-3]) / closes.iloc[-3]), 6)

    # Volume ratio: current bar vs 20-bar average of prior bars
    volume_ratio: float | None = None
    if "volume" in df.columns and len(df) >= 2:
        vols = df["volume"].astype(float)
        avg_vol = float(vols.iloc[:-1].tail(20).mean())
        if avg_vol > 0:
            volume_ratio = round(float(vols.iloc[-1]) / avg_vol, 3)

    # VWAP cross direction: did price cross VWAP on this bar?
    vwap_val = indicator_row.get("vwap")
    vwap_cross_dir: str | None = None
    if vwap_val and len(df) >= 2:
        prev_close = float(df["close"].iloc[-2])
        if prev_close < vwap_val and current_price > vwap_val:
            vwap_cross_dir = "RECLAIM"
        elif prev_close > vwap_val and current_price < vwap_val:
            vwap_cross_dir = "LOSE"

    # Candle structure: higher low / lower high (single-bar)
    candle_higher_low: bool | None = None
    candle_lower_high: bool | None = None
    if len(df) >= 2:
        curr_low = float(df["low"].iloc[-1])
        prev_low = float(df["low"].iloc[-2])
        curr_high = float(df["high"].iloc[-1])
        prev_high = float(df["high"].iloc[-2])
        if curr_low > prev_low and recent_return < 0:
            candle_higher_low = True
        if curr_high < prev_high and recent_return > 0:
            candle_lower_high = True

    # Swing structure confirmation from candle_context (multi-bar, higher quality)
    _raw_hh_hl = indicator_row.get("candle_hh_hl")
    candle_hh_hl: bool | None = bool(_raw_hh_hl) if _raw_hh_hl is not None else None
    _raw_lh_ll = indicator_row.get("candle_lh_ll")
    candle_lh_ll: bool | None = bool(_raw_lh_ll) if _raw_lh_ll is not None else None

    # Bar time in ET (HH:MM) — used by time-of-day weight multiplier
    bar_time_et: str | None = None
    if len(df) >= 1:
        try:
            ts_raw = df["timestamp"].iloc[-1]
            if isinstance(ts_raw, str):
                dt_utc = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
            else:
                dt_utc = ts_raw.to_pydatetime()
                if dt_utc.tzinfo is None:
                    dt_utc = dt_utc.replace(tzinfo=timezone.utc)
            bar_time_et = dt_utc.astimezone(ET).strftime("%H:%M")
        except Exception:
            bar_time_et = None

    return EvidenceFields(
        ema9=indicator_row.get("ema9"),
        ema21=indicator_row.get("ema21"),
        ema50=indicator_row.get("ema50"),
        ema_state=indicator_row.get("ema_state"),
        ema_spread_pct=indicator_row.get("ema_spread_pct"),
        vwap=vwap_val,
        price=current_price,
        price_vs_vwap=indicator_row.get("price_vs_vwap"),
        vwap_distance_pct=indicator_row.get("vwap_distance_pct"),
        vwap_motion=indicator_row.get("vwap_motion"),
        vwap_cross_dir=vwap_cross_dir,
        daily_trend=indicator_row.get("daily_trend"),
        poc=indicator_row.get("poc"),
        nearest_support=indicator_row.get("nearest_support"),
        nearest_resistance=indicator_row.get("nearest_resistance"),
        last_swing_high=indicator_row.get("swing_high"),
        last_swing_low=indicator_row.get("swing_low"),
        recent_return_5m=round(recent_return, 6),
        recent_volatility=round(volatility, 6),
        volume_ratio=volume_ratio,
        candle_higher_low=candle_higher_low,
        candle_lower_high=candle_lower_high,
        orb_high=indicator_row.get("orb_high"),
        orb_low=indicator_row.get("orb_low"),
        rsi_14=indicator_row.get("rsi_14"),
        rsi_state=indicator_row.get("rsi_state"),
        bull_score=indicator_row.get("bull_score"),
        bear_score=indicator_row.get("bear_score"),
        confluence_bias=indicator_row.get("confluence_bias"),
        candle_hh_hl=candle_hh_hl,
        candle_lh_ll=candle_lh_ll,
        bar_time_et=bar_time_et,
        slope_3bar=slope_3bar,
        tf=tf,
        bar_minutes=TIMEFRAMES.get(tf, {}).get("bar_minutes"),
    )


async def run_evaluation(
    ticker: str,
    df: pd.DataFrame,
    current_price: float,
    indicator_row: dict,
    tf: str = PRIMARY_TIMEFRAME,
) -> PredictionOutput:
    """
    Full evaluation pipeline:
    1. Build evidence from indicators (tf-aware)
    2. Rule engine (primary)
    3. ML blend (secondary, if trained)
    4. Log to DB
    5. Return PredictionOutput
    """
    evidence = await build_evidence(ticker, df, current_price, indicator_row, tf=tf)

    # --- Rule engine ---
    rule_result = rule_evaluate(ticker, evidence)

    # --- ML blend (per-TF model via registry) ---
    ml_result = ml_registry.predict(evidence)
    final = rule_result

    if ml_result is not None:
        ml_direction, ml_confidence = ml_result
        if rule_result.prediction != "ABSTAIN" and ml_direction == rule_result.prediction:
            # Agreement: boost confidence slightly
            blended_conf = min(1.0, rule_result.confidence * 0.7 + ml_confidence * 0.3)
            final = rule_result.model_copy(update={"confidence": round(blended_conf, 4)})
            final.rules_triggered.append("ml_agrees")
        elif rule_result.prediction == "ABSTAIN" and ml_confidence >= ABSTAIN_CONFIDENCE_THRESHOLD:
            # Rule abstained but ML is confident — use ML result
            final = rule_result.model_copy(update={
                "prediction": ml_direction,
                "confidence": ml_confidence,
                "rules_triggered": rule_result.rules_triggered + ["ml_override"],
            })

    # --- Persist ---
    prediction_row = {
        "ticker": ticker,
        "timestamp": final.timestamp,
        "prediction": final.prediction,
        "confidence": final.confidence,
        "evidence": final.evidence.model_dump_json(),
        "rules_triggered": json.dumps(final.rules_triggered),
        "notes": final.notes,
        "timeframe": tf,
    }
    prediction_id = await db.insert_prediction(prediction_row)

    # Schedule outcome resolution after PREDICTION_HORIZON_BARS bars
    # (handled in scheduler.py by checking stored predictions)

    logger.debug("[%s] prediction=%s conf=%.2f rules=%s",
                 ticker, final.prediction, final.confidence, final.rules_triggered)
    return final


async def resolve_outcomes() -> None:
    """
    For each pending prediction, look up the close price at the TF-appropriate
    horizon and record the outcome. Called by the scheduler on each cycle.
    Horizon comes from TIMEFRAMES[tf]["prediction_horizon_minutes"]; legacy
    rows without a timeframe column default to PRIMARY_TIMEFRAME.
    """
    primary_horizon_min = TIMEFRAMES[PRIMARY_TIMEFRAME]["prediction_horizon_minutes"]
    conn = await db.get_db()
    try:
        # Fetch predictions without outcomes (incl. tf so we can pick horizon)
        rows = await conn.execute_fetchall(
            "SELECT id, ticker, timestamp, prediction, timeframe FROM predictions WHERE outcome IS NULL"
        )
        for row in rows:
            tf = (row["timeframe"] if "timeframe" in row.keys() else None) or PRIMARY_TIMEFRAME
            horizon_min = TIMEFRAMES.get(tf, {}).get("prediction_horizon_minutes", primary_horizon_min)

            pred_ts = pd.Timestamp(row["timestamp"], tz="UTC")
            horizon_ts = pred_ts + pd.Timedelta(minutes=horizon_min)
            now = pd.Timestamp.now(tz="UTC")

            if now < horizon_ts:
                continue  # not yet time

            candles = await conn.execute_fetchall(
                "SELECT close FROM candles WHERE ticker = ? AND timeframe = ? AND timestamp >= ? "
                "ORDER BY timestamp ASC LIMIT 1",
                (row["ticker"], tf, horizon_ts.isoformat()),
            )
            if not candles:
                continue

            entry_candles = await conn.execute_fetchall(
                "SELECT close FROM candles WHERE ticker = ? AND timeframe = ? AND timestamp <= ? "
                "ORDER BY timestamp DESC LIMIT 1",
                (row["ticker"], tf, pred_ts.isoformat()),
            )
            if not entry_candles:
                continue

            entry_price = float(entry_candles[0]["close"])
            exit_price = float(candles[0]["close"])
            ret = (exit_price - entry_price) / entry_price

            if ret > 0.001:
                outcome = "UP"
            elif ret < -0.001:
                outcome = "DOWN"
            else:
                outcome = "FLAT"

            await db.update_prediction_outcome(row["id"], outcome, horizon_ts.isoformat())
    finally:
        await conn.close()


async def retrain_ml() -> None:
    """Retrain one ML model per timeframe, using only that TF's completed predictions."""
    conn = await db.get_db()
    try:
        for tf in TIMEFRAMES:
            rows = await conn.execute_fetchall(
                "SELECT evidence, outcome FROM predictions "
                "WHERE outcome IS NOT NULL AND COALESCE(timeframe, ?) = ?",
                (PRIMARY_TIMEFRAME, tf),
            )
            ml_registry.train(tf, [dict(r) for r in rows])
    finally:
        await conn.close()

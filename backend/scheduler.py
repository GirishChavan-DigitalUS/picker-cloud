"""
Scheduler: runs three clock-aligned fetch loops (2m / 5m / 15m), each cycling
through all configured tickers, fetching OHLCV via yfinance, computing
indicators, emitting signals, running AI evaluation, and broadcasting via
WebSocket.

Phase 1: all three TF loops fetch & persist candles. Only the PRIMARY_TIMEFRAME
(2m) runs the full indicator/signal/AI pipeline. Higher-TF indicator computation
is enabled in Phase 2.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

import pandas as pd

from config import TICKERS, TIMEFRAMES, PRIMARY_TIMEFRAME, OHLCV_FETCH_LIMIT, is_regular_hours
from mcp_client import tv_mcp
from indicators.ema import compute_crossover
from indicators.vwap import compute_vwap
from indicators.trend import compute_daily_trend
from indicators.volume_profile import compute_volume_profile
from indicators.session_levels import compute_session_levels
from indicators.support_resistance import compute_support_resistance
from indicators.swings import compute_swings
from indicators.rsi import compute_rsi
from indicators.confluence import compute_confluence
from indicators.candle_context import compute_candle_context
from signals.crossover import detect_crossover
from signals.vwap_motion import detect_vwap_cross
from signals.sr_breaks import detect_sr_breaks
from signals.composite import evaluate_composite
from ai.evaluator import run_evaluation, resolve_outcomes, retrain_ml
from api.ws import broadcast
from push import broadcast_push
import db

logger = logging.getLogger(__name__)

_tasks: dict[str, asyncio.Task] = {}

# Per-(ticker, tf) state cache for cross-cycle signal comparison
_prev_state:    dict[tuple[str, str], dict] = {}
_prev_snapshot: dict[tuple[str, str], dict] = {}
_session_fired: dict[tuple[str, str], set]  = {}
_session_date:  str = ""


async def start_scheduler() -> None:
    """Launch one fetch loop per configured timeframe."""
    global _tasks
    for tf in TIMEFRAMES:
        _tasks[tf] = asyncio.create_task(_loop(tf))
        logger.info(
            "Scheduler started tf=%s interval=%ds stagger=+%ds",
            tf,
            TIMEFRAMES[tf]["interval_seconds"],
            TIMEFRAMES[tf]["stagger_offset_seconds"],
        )


async def stop_scheduler() -> None:
    global _tasks
    for tf, task in _tasks.items():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        logger.info("Scheduler stopped tf=%s", tf)
    _tasks.clear()


def _seconds_until_next_tick(interval_seconds: int, stagger_offset_seconds: int) -> float:
    """
    Return seconds to sleep until the next clock-aligned tick.

    Tick fires at (epoch_seconds % interval_seconds) == 0, then offset by
    stagger_offset_seconds. Example: 5m interval, +30s stagger → fires at
    :00:30, :05:30, :10:30, … of every hour.
    """
    now = datetime.now(timezone.utc).timestamp()
    # next multiple of interval_seconds strictly greater than now-stagger
    base = now - stagger_offset_seconds
    next_base = (int(base // interval_seconds) + 1) * interval_seconds
    next_tick = next_base + stagger_offset_seconds
    return max(0.0, next_tick - now)


async def _loop(tf: str) -> None:
    tf_cfg = TIMEFRAMES[tf]
    interval = tf_cfg["interval_seconds"]
    stagger = tf_cfg["stagger_offset_seconds"]
    # Initial cycle on startup so the UI has data without waiting one bar.
    await _run_cycle(tf)
    while True:
        delay = _seconds_until_next_tick(interval, stagger)
        logger.debug("tf=%s sleeping %.1fs until next tick", tf, delay)
        await asyncio.sleep(delay)
        await _run_cycle(tf)


async def _run_cycle(tf: str) -> None:
    global _session_date, _session_fired
    # Single cycle_ts shared across all tickers in this refresh cycle so that
    # the API can filter to "latest refresh" by selecting max(cycle_ts).
    cycle_ts = datetime.now(timezone.utc).isoformat()
    logger.info("--- Fetch cycle start tf=%s cycle_ts=%s ---", tf, cycle_ts)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if today != _session_date:
        _session_date = today
        _session_fired.clear()
        logger.info("Session reset — new trading day")

    for ticker in TICKERS:
        try:
            await _process_ticker(ticker, cycle_ts, tf)
        except Exception as exc:
            logger.error("[%s tf=%s] cycle error: %s", ticker, tf, exc, exc_info=True)

    # Outcome resolution + ML retraining are tied to the primary TF only —
    # they operate on the predictions table which is fed by the primary loop.
    if tf == PRIMARY_TIMEFRAME:
        await resolve_outcomes()
        await retrain_ml()
    logger.info("--- Fetch cycle complete tf=%s ---", tf)


async def process_ticker_once(ticker: str, tf: str = PRIMARY_TIMEFRAME) -> None:
    """Public wrapper — used by the on-demand /api/ticker/{ticker}/refresh endpoint."""
    cycle_ts = datetime.now(timezone.utc).isoformat()
    await _process_ticker(ticker, cycle_ts, tf)


async def _process_ticker(ticker: str, cycle_ts: str, tf: str) -> None:
    df, current_price = await tv_mcp.fetch_ticker(ticker, limit=OHLCV_FETCH_LIMIT, tf=tf)

    if df.empty:
        logger.warning("[%s tf=%s] no bars returned", ticker, tf)
        return

    # --- Persist all bars (including in-progress last bar) for chart display ---
    await db.upsert_candles(ticker, df.to_dict(orient="records"))

    now_ts = datetime.now(timezone.utc).isoformat()

    # Drop the in-progress (current) bar — only compute indicators and emit
    # signals on fully-closed candles to avoid false mid-candle triggers.
    df_closed = df.iloc[:-1]
    if df_closed.empty:
        logger.warning("[%s tf=%s] insufficient closed bars for signal computation", ticker, tf)
        return

    # --- Compute indicators on closed bars only ---
    ema_data = compute_crossover(df_closed)
    vwap_data = compute_vwap(df_closed, current_price)
    trend_data = compute_daily_trend(df_closed)
    poc_data = compute_volume_profile(df_closed)
    session_lvl = compute_session_levels(df_closed)
    swings_data = compute_swings(df_closed, tf=tf)
    sr_data = compute_support_resistance(df_closed, current_price)
    rsi_data = compute_rsi(df_closed)

    closes = df_closed["close"].astype(float)
    recent_return = float((closes.iloc[-1] - closes.iloc[-2]) / closes.iloc[-2]) if len(closes) >= 2 else 0.0
    volatility = float(closes.pct_change().dropna().tail(20).std()) if len(closes) >= 5 else 0.0

    # RVOL: current bar vs 20-bar average of prior bars
    vols = df_closed["volume"].astype(float) if "volume" in df_closed.columns else None
    rvol: float | None = None
    if vols is not None and len(vols) >= 2:
        avg_vol = float(vols.iloc[:-1].tail(20).mean())
        if avg_vol > 0:
            rvol = round(float(vols.iloc[-1]) / avg_vol, 3)
    volume_state: str | None = None
    if rvol is not None:
        volume_state = "HIGH" if rvol > 1.5 else ("LOW" if rvol < 0.5 else "NORMAL")

    snapshot = {
        "timestamp": now_ts,
        **ema_data,
        **vwap_data,
        **trend_data,
        **poc_data,
        "swing_high": swings_data.get("swing_high"),
        "swing_high_ts": swings_data.get("swing_high_ts"),
        "swing_low": swings_data.get("swing_low"),
        "swing_low_ts": swings_data.get("swing_low_ts"),
        "nearest_support": sr_data.get("nearest_support"),
        "nearest_resistance": sr_data.get("nearest_resistance"),
        "recent_return_5m": round(recent_return, 6),
        "recent_volatility": round(volatility, 6),
        # Volume confirmation (v3)
        "rvol":         rvol,
        "volume_state": volume_state,
        # RSI (v3)
        **rsi_data,
        # Session levels (v2)
        "pm_high":        session_lvl.get("pm_high"),
        "pm_low":         session_lvl.get("pm_low"),
        "orb_high":       session_lvl.get("orb_high"),
        "orb_low":        session_lvl.get("orb_low"),
        "prev_day_high":  session_lvl.get("prev_day_high"),
        "prev_day_low":   session_lvl.get("prev_day_low"),
        "poc_pre":        session_lvl.get("poc_pre"),
        "poc_regular":    session_lvl.get("poc_regular"),
        "poc_after":      session_lvl.get("poc_after"),
    }

    # Confluence (v3) — depends on full snapshot + current price
    confluence_data = compute_confluence(snapshot, current_price)
    snapshot.update(confluence_data)

    # Candle context (v4) — patterns, structure, volume char, level proximity
    candle_ctx = compute_candle_context(df_closed, snapshot, current_price, tf=tf)
    snapshot.update(candle_ctx)

    # Build DB snapshot: serialize list fields that SQLite cannot store natively
    db_snapshot = {**snapshot}
    if isinstance(db_snapshot.get("candle_patterns"), list):
        db_snapshot["candle_patterns"] = json.dumps(db_snapshot["candle_patterns"])

    await db.upsert_indicator_snapshot(ticker, db_snapshot, timeframe=tf)

    # --- Detect signals (regular hours only) ---
    prev = _prev_state.get((ticker, tf), {})
    signals: list[dict] = []

    if is_regular_hours():
        cross_sig = detect_crossover(ticker, prev.get("ema_state"), ema_data)
        if cross_sig:
            signals.append(cross_sig)

        vwap_sig = detect_vwap_cross(ticker, prev.get("price_vs_vwap"), vwap_data, timestamp=now_ts)
        if vwap_sig:
            signals.append(vwap_sig)

        sr_sigs = detect_sr_breaks(
            ticker, current_price,
            prev.get("nearest_support"), prev.get("nearest_resistance"),
            sr_data, timestamp=now_ts,
        )
        signals.extend(sr_sigs)
    else:
        logger.debug("[%s tf=%s] outside regular hours — signals suppressed", ticker, tf)

    for sig in signals:
        await db.insert_signal(ticker, sig)
        sig_with_tf = {**sig, "timeframe": tf}
        await broadcast({"type": "signal", "data": sig_with_tf})

    # --- AI evaluation ---
    prediction = await run_evaluation(ticker, df_closed, current_price, snapshot, tf=tf)
    await broadcast({
        "type": "prediction",
        "data": {
            "ticker": ticker,
            "timestamp": prediction.timestamp,
            "prediction": prediction.prediction,
            "confidence": prediction.confidence,
            "rules_triggered": json.dumps(prediction.rules_triggered),
            "notes": prediction.notes,
            "timeframe": tf,
        },
    })

    # --- Price update broadcast ---
    # Broadcast the FULL indicator snapshot so the frontend always has every
    # field up-to-date (ema9/21/50, vwap, rsi_14, rvol, orb levels, etc.)
    # without requiring an additional REST call.
    # Broadcast a slim price_update with only the fields the frontend needs
    # for live-updating dashboard cards and chart overlays. The full snapshot
    # is available via the REST /dashboard endpoint on initial load.
    _WS_FIELDS = (
        "ema9", "ema21", "ema50", "ema_state", "vwap", "vwap_distance_pct",
        "price_vs_vwap", "vwap_motion", "daily_trend", "rsi_14", "rsi_state",
        "rvol", "volume_state", "nearest_support", "nearest_resistance",
        "bull_score", "bear_score", "confluence_bias", "candle_structure",
        "candle_patterns",
    )
    slim_snapshot = {k: snapshot.get(k) for k in _WS_FIELDS if snapshot.get(k) is not None}
    await broadcast({
        "type": "price_update",
        "data": {
            "ticker": ticker,
            "price": current_price,
            "session": df["session"].iloc[-1],
            "timeframe": tf,
            **slim_snapshot,
        },
    })

    # Cache state for next cycle
    _prev_state[(ticker, tf)] = {
        "ema_state":          ema_data.get("ema_state"),
        "price_vs_vwap":      vwap_data.get("price_vs_vwap"),
        "nearest_support":    sr_data.get("nearest_support"),
        "nearest_resistance": sr_data.get("nearest_resistance"),
        "vwap_motion":        vwap_data.get("vwap_motion"),
        "rvol":               snapshot.get("rvol"),
    }

    prev_snap = _prev_snapshot.get((ticker, tf))
    if (ticker, tf) not in _session_fired:
        _session_fired[(ticker, tf)] = set()

    if is_regular_hours():
        composite_alerts = evaluate_composite(
            ticker=ticker,
            snapshot=snapshot,
            prev_snapshot=prev_snap,
            confidence=prediction.confidence,
            current_price=current_price,
            session_fired=_session_fired[(ticker, tf)],
            prediction_dir=prediction.prediction or "NEUTRAL",
        )
        for alert in composite_alerts:
            alert["timeframe"] = tf
            alert["cycle_ts"] = cycle_ts
            alert["current_price"] = current_price
            await db.insert_composite_alert(alert)
            if alert["signal"].startswith("POWER_TREND"):
                _session_fired[(ticker, tf)].add(alert["signal"])
            await broadcast({"type": "composite_alert", "data": alert})
            if (alert.get("tier", 3) <= 2
                    and not alert.get("suppressed_by")
                    and alert.get("ai_confidence", 0) >= 0.85):
                asyncio.create_task(broadcast_push(alert))
            logger.info("[%s tf=%s] COMPOSITE %s tier=%d conf=%.2f suppressed=%s",
                        ticker, tf, alert["signal"], alert["tier"],
                        alert["ai_confidence"], alert.get("suppressed_by"))
    else:
        logger.debug("[%s tf=%s] outside regular hours — composite alerts suppressed", ticker, tf)

    _prev_snapshot[(ticker, tf)] = {**snapshot, "price": current_price, "rvol": snapshot.get("rvol")}

    logger.info("[%s tf=%s] price=%.2f ema=%s vwap=%s trend=%s pred=%s(%.2f)",
                ticker, tf, current_price,
                ema_data.get("ema_state", "?"),
                vwap_data.get("price_vs_vwap", "?"),
                trend_data.get("daily_trend", "?"),
                prediction.prediction, prediction.confidence)

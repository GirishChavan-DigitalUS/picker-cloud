"""REST endpoints for indicator data."""
from __future__ import annotations

import asyncio
import json
import logging
from fastapi import APIRouter, HTTPException, Query

from config import PRIMARY_TIMEFRAME, TIMEFRAMES
import db

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/indicators/{ticker}/tape-read")
async def request_tape_read(ticker: str):
    """
    On-demand LLM tape read.  Called by the UI when the user clicks
    'Generate Read'.  Loads the latest stored snapshot, calls the LLM,
    persists the narrative, and returns it.
    """
    ticker = ticker.upper()
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            "SELECT * FROM indicators WHERE ticker=? ORDER BY timestamp DESC LIMIT 1",
            (ticker,),
        )
    finally:
        await conn.close()

    if not rows:
        raise HTTPException(status_code=404, detail=f"No snapshot found for {ticker}")

    snapshot = dict(rows[0])

    # Deserialise candle_patterns so generate_tape_read receives a list
    raw_patterns = snapshot.get("candle_patterns")
    if isinstance(raw_patterns, str):
        try:
            snapshot["candle_patterns"] = json.loads(raw_patterns)
        except Exception:
            snapshot["candle_patterns"] = []

    current_price = float(snapshot.get("price") or snapshot.get("close") or 0.0)

    # Enrich snapshot with latest AI prediction so the LLM can synthesise both views
    conn_pred = await db.get_db()
    try:
        pred_rows = await conn_pred.execute_fetchall(
            "SELECT prediction, confidence FROM predictions "
            "WHERE ticker=? ORDER BY id DESC LIMIT 1",
            (ticker,),
        )
    finally:
        await conn_pred.close()
    if pred_rows:
        snapshot["ai_prediction"] = pred_rows[0]["prediction"]
        snapshot["ai_confidence"] = pred_rows[0]["confidence"]

    from ai.tape_read import generate_tape_read
    narrative = await generate_tape_read(ticker, snapshot, current_price, force=True)

    if narrative:
        # Persist the fresh narrative directly
        conn2 = await db.get_db()
        try:
            await conn2.execute(
                "UPDATE indicators SET tape_read_narrative=? "
                "WHERE ticker=? AND timestamp=("
                "  SELECT MAX(timestamp) FROM indicators WHERE ticker=?)",
                (narrative, ticker, ticker),
            )
            await conn2.commit()
        finally:
            await conn2.close()

    return {"ticker": ticker, "tape_read_narrative": narrative}


@router.get("/indicators/{ticker}")
async def get_latest_indicators(
    ticker: str,
    timeframe: str = Query(PRIMARY_TIMEFRAME),
):
    ticker = ticker.upper()
    if timeframe not in TIMEFRAMES:
        timeframe = PRIMARY_TIMEFRAME
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            "SELECT * FROM indicators WHERE ticker=? AND COALESCE(timeframe, ?)=? "
            "ORDER BY timestamp DESC LIMIT 1",
            (ticker, PRIMARY_TIMEFRAME, timeframe),
        )
    finally:
        await conn.close()
    if not rows:
        return {"ticker": ticker, "snapshot": None, "timeframe": timeframe}
    return {"ticker": ticker, "snapshot": dict(rows[0]), "timeframe": timeframe}


@router.get("/indicators/{ticker}/session-snapshot")
async def get_session_snapshot(
    ticker: str,
    trading_date: str = Query(..., description="ET date YYYY-MM-DD to retrieve last snapshot for"),
):
    """
    Return the last indicator snapshot and last prediction for a specific trading date.
    Used by the frontend to display historical session data in after-hours / closed states.
    The last snapshot of a regular session corresponds to the ~15:58–16:00 ET bar.
    """
    ticker = ticker.upper()
    conn = await db.get_db()
    try:
        # Last indicator snapshot whose UTC timestamp falls on the requested ET calendar date.
        # Regular session bars are 09:30–16:00 ET which is always same calendar day in UTC.
        ind_rows = await conn.execute_fetchall(
            "SELECT * FROM indicators WHERE ticker=? AND timestamp LIKE ? "
            "ORDER BY timestamp DESC LIMIT 1",
            (ticker, f"{trading_date}%"),
        )
        # Last prediction for the same date
        pred_rows = await conn.execute_fetchall(
            "SELECT * FROM predictions WHERE ticker=? AND timestamp LIKE ? "
            "ORDER BY timestamp DESC LIMIT 1",
            (ticker, f"{trading_date}%"),
        )
    finally:
        await conn.close()

    snapshot = dict(ind_rows[0]) if ind_rows else None
    prediction = dict(pred_rows[0]) if pred_rows else None

    # Deserialise candle_patterns JSON string if present
    if snapshot:
        raw_cp = snapshot.get("candle_patterns")
        if isinstance(raw_cp, str):
            try:
                snapshot["candle_patterns"] = __import__("json").loads(raw_cp)
            except Exception:
                snapshot["candle_patterns"] = []

    return {
        "ticker": ticker,
        "trading_date": trading_date,
        "snapshot": snapshot,
        "prediction": prediction,
    }



@router.get("/indicators/{ticker}/history")
async def get_indicator_history(
    ticker: str,
    limit: int = Query(200, ge=1, le=1000),
    timeframe: str = Query(PRIMARY_TIMEFRAME),
):
    ticker = ticker.upper()
    if timeframe not in TIMEFRAMES:
        timeframe = PRIMARY_TIMEFRAME
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            "SELECT * FROM indicators WHERE ticker=? AND COALESCE(timeframe, ?)=? "
            "ORDER BY timestamp DESC LIMIT ?",
            (ticker, PRIMARY_TIMEFRAME, timeframe, limit),
        )
    finally:
        await conn.close()
    history = [dict(r) for r in reversed(rows)]
    return {"ticker": ticker, "history": history, "count": len(history), "timeframe": timeframe}


@router.get("/dashboard")
async def get_dashboard(
    tickers: str = Query(default=""),
    timeframe: str = Query(PRIMARY_TIMEFRAME),
):
    """Return the latest indicator snapshot + prediction for the requested tickers.
    Pass ?tickers=SPY,QQQ,META (comma-separated). Falls back to config TICKERS if omitted.
    """
    from config import TICKERS as DEFAULT_TICKERS
    if tickers.strip():
        ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    else:
        ticker_list = list(DEFAULT_TICKERS)
    if timeframe not in TIMEFRAMES:
        timeframe = PRIMARY_TIMEFRAME
    conn = await db.get_db()
    try:
        result = {}
        for ticker in ticker_list:
            ind_rows = await conn.execute_fetchall(
                "SELECT * FROM indicators WHERE ticker=? AND COALESCE(timeframe, ?)=? "
                "ORDER BY timestamp DESC LIMIT 1",
                (ticker, PRIMARY_TIMEFRAME, timeframe),
            )
            pred_rows = await conn.execute_fetchall(
                "SELECT * FROM predictions WHERE ticker=? AND COALESCE(timeframe, ?)=? "
                "ORDER BY timestamp DESC LIMIT 1",
                (ticker, PRIMARY_TIMEFRAME, timeframe),
            )
            candle_rows = await conn.execute_fetchall(
                "SELECT close, session FROM candles WHERE ticker=? AND timeframe=? "
                "ORDER BY timestamp DESC LIMIT 2",
                (ticker, timeframe),
            )
            price = float(candle_rows[0]["close"]) if candle_rows else None
            prev_close = float(candle_rows[1]["close"]) if len(candle_rows) >= 2 else None
            change_pct = round((price - prev_close) / prev_close * 100, 2) if (price and prev_close) else None
            result[ticker] = {
                "indicators": dict(ind_rows[0]) if ind_rows else None,
                "prediction": dict(pred_rows[0]) if pred_rows else None,
                "price": price,
                "prev_close": prev_close,
                "change_pct": change_pct,
                "session": candle_rows[0]["session"] if candle_rows else "closed",
            }
    finally:
        await conn.close()
    return {"dashboard": result, "timeframe": timeframe}


@router.post("/ticker/{ticker}/refresh")
async def refresh_ticker(ticker: str):
    """Fetch live data for any ticker on-demand (used when user adds a new ticker)."""
    from scheduler import process_ticker_once
    ticker = ticker.upper()
    try:
        await process_ticker_once(ticker)
    except Exception as exc:
        logger.error("refresh_ticker [%s] failed: %s", ticker, exc, exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))
    conn = await db.get_db()
    try:
        ind_rows = await conn.execute_fetchall(
            "SELECT * FROM indicators WHERE ticker=? ORDER BY timestamp DESC LIMIT 1",
            (ticker,),
        )
        candle_rows = await conn.execute_fetchall(
            "SELECT close, session FROM candles WHERE ticker=? ORDER BY timestamp DESC LIMIT 1",
            (ticker,),
        )
        pred_rows = await conn.execute_fetchall(
            "SELECT * FROM predictions WHERE ticker=? ORDER BY timestamp DESC LIMIT 1",
            (ticker,),
        )
    finally:
        await conn.close()
    # If no candle data was stored, yfinance returned nothing — ticker is invalid
    if not candle_rows:
        raise HTTPException(status_code=404, detail=f"Ticker '{ticker}' not found or returned no data")
    return {
        "ticker": ticker,
        "indicators": dict(ind_rows[0]) if ind_rows else None,
        "prediction": dict(pred_rows[0]) if pred_rows else None,
        "price": float(candle_rows[0]["close"]) if candle_rows else None,
        "session": candle_rows[0]["session"] if candle_rows else "closed",
    }


@router.post("/refresh-all")
async def refresh_all_tickers():
    """Trigger an immediate fetch cycle for all tickers."""
    from config import TICKERS
    from scheduler import process_ticker_once

    async def _safe(t: str) -> None:
        try:
            await process_ticker_once(t)
        except Exception as exc:
            logger.error("refresh_all [%s]: %s", t, exc)

    await asyncio.gather(*[_safe(t) for t in TICKERS])
    return {"status": "ok", "tickers": list(TICKERS)}

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
    On-demand LLM tape read — currently disabled for performance.
    Returns the last cached narrative (if any) without calling the LLM.
    """
    ticker = ticker.upper()
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            "SELECT tape_read_narrative FROM indicators WHERE ticker=? ORDER BY timestamp DESC LIMIT 1",
            (ticker,),
        )
    finally:
        await conn.close()

    narrative = rows[0]["tape_read_narrative"] if rows and rows[0]["tape_read_narrative"] else None
    return {"ticker": ticker, "tape_read_narrative": narrative, "disabled": True}


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
    import re as _re
    if not _re.match(r'^\d{4}-\d{2}-\d{2}$', trading_date):
        raise HTTPException(status_code=400, detail="Invalid date format. Expected YYYY-MM-DD.")
    ticker = ticker.upper()
    # Use index-friendly range query instead of LIKE
    date_start = f"{trading_date}T00:00:00Z"
    date_end   = f"{trading_date}T23:59:59Z"
    conn = await db.get_db()
    try:
        ind_rows = await conn.execute_fetchall(
            "SELECT * FROM indicators WHERE ticker=? AND timestamp >= ? AND timestamp <= ? "
            "ORDER BY timestamp DESC LIMIT 1",
            (ticker, date_start, date_end),
        )
        pred_rows = await conn.execute_fetchall(
            "SELECT * FROM predictions WHERE ticker=? AND timestamp >= ? AND timestamp <= ? "
            "ORDER BY timestamp DESC LIMIT 1",
            (ticker, date_start, date_end),
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
        # Batch query: fetch latest indicator, prediction, and candle rows
        # for ALL requested tickers in 3 queries instead of 3×N.
        placeholders = ",".join("?" for _ in ticker_list)

        ind_rows = await conn.execute_fetchall(
            f"SELECT * FROM indicators WHERE id IN ("
            f"  SELECT MAX(id) FROM indicators"
            f"  WHERE ticker IN ({placeholders}) AND COALESCE(timeframe, ?)=?"
            f"  GROUP BY ticker"
            f")",
            (*ticker_list, PRIMARY_TIMEFRAME, timeframe),
        )
        ind_map = {row["ticker"]: dict(row) for row in ind_rows}

        pred_rows = await conn.execute_fetchall(
            f"SELECT * FROM predictions WHERE id IN ("
            f"  SELECT MAX(id) FROM predictions"
            f"  WHERE ticker IN ({placeholders}) AND COALESCE(timeframe, ?)=?"
            f"  GROUP BY ticker"
            f")",
            (*ticker_list, PRIMARY_TIMEFRAME, timeframe),
        )
        pred_map = {row["ticker"]: dict(row) for row in pred_rows}

        candle_rows = await conn.execute_fetchall(
            f"SELECT ticker, close, session FROM candles"
            f" WHERE ticker IN ({placeholders}) AND timeframe=?"
            f" ORDER BY timestamp DESC LIMIT ?",
            (*ticker_list, timeframe, len(ticker_list) * 2),
        )
        # Group by ticker: keep first 2 rows per ticker (latest + prev)
        candle_map: dict[str, list] = {}
        for row in candle_rows:
            t = row["ticker"]
            if t not in candle_map:
                candle_map[t] = []
            if len(candle_map[t]) < 2:
                candle_map[t].append(row)

        for ticker in ticker_list:
            c_rows = candle_map.get(ticker, [])
            price = float(c_rows[0]["close"]) if c_rows else None
            prev_close = float(c_rows[1]["close"]) if len(c_rows) >= 2 else None
            change_pct = round((price - prev_close) / prev_close * 100, 2) if (price and prev_close) else None
            result[ticker] = {
                "indicators": ind_map.get(ticker),
                "prediction": pred_map.get(ticker),
                "price": price,
                "prev_close": prev_close,
                "change_pct": change_pct,
                "session": c_rows[0]["session"] if c_rows else "closed",
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

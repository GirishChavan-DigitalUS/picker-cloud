"""REST endpoints for OHLCV candle data."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

import db

router = APIRouter()


@router.get("/candles/{ticker}")
async def get_candles(
    ticker: str,
    timeframe: str = Query("2m", description="Candle timeframe: '2m' | '5m' | '15m'"),
    limit: int = Query(400, ge=1, le=2000),
    session: str | None = Query(None, description="Filter by session: pre|regular|after"),
    today_only: bool = Query(False, description="Return only candles from the latest trading date (4 AM ET onwards)"),
    trading_date: str | None = Query(None, description="Return candles for a specific ET date (YYYY-MM-DD). Overrides today_only."),
):
    ticker = ticker.upper()
    conn = await db.get_db()
    try:
        # First pass: get all recent bars (we need to determine the latest date)
        base_sql = "SELECT * FROM candles WHERE ticker=? AND timeframe=?"
        base_args: list = [ticker, timeframe]
        if session:
            base_sql += " AND session=?"
            base_args.append(session)
        base_sql += " ORDER BY timestamp DESC LIMIT ?"
        base_args.append(limit)
        rows = await conn.execute_fetchall(base_sql, base_args)
    finally:
        await conn.close()

    bars = [dict(r) for r in reversed(rows)]

    if trading_date:
        # Return only bars whose UTC timestamp falls on this ET calendar date.
        # Regular session (09:30–16:00 ET) always maps to the same calendar date
        # in UTC (EDT offset −4h: 13:30–20:00 UTC; EST offset −5h: 14:30–21:00 UTC).
        bars = [b for b in bars if b["timestamp"][:10] == trading_date]
    elif today_only and bars:
        # Find the latest date present (ISO timestamps, so string comparison works)
        latest_date = max(b["timestamp"][:10] for b in bars)
        bars = [b for b in bars if b["timestamp"][:10] >= latest_date]

    return {"ticker": ticker, "timeframe": timeframe, "bars": bars, "count": len(bars)}

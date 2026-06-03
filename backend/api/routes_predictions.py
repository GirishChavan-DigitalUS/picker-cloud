"""REST endpoints for AI predictions."""
from __future__ import annotations

from fastapi import APIRouter, Query

from config import PRIMARY_TIMEFRAME, TIMEFRAMES
import db

router = APIRouter()


@router.get("/predictions/{ticker}")
async def get_predictions(
    ticker: str,
    limit: int = Query(50, ge=1, le=500),
    timeframe: str = Query(PRIMARY_TIMEFRAME),
):
    ticker = ticker.upper()
    if timeframe not in TIMEFRAMES:
        timeframe = PRIMARY_TIMEFRAME
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            "SELECT * FROM predictions WHERE ticker=? AND COALESCE(timeframe, ?)=? "
            "ORDER BY timestamp DESC LIMIT ?",
            (ticker, PRIMARY_TIMEFRAME, timeframe, limit),
        )
    finally:
        await conn.close()
    return {"ticker": ticker, "predictions": [dict(r) for r in rows], "timeframe": timeframe}


@router.get("/predictions/{ticker}/accuracy")
async def get_accuracy(ticker: str):
    ticker = ticker.upper()
    conn = await db.get_db()
    try:
        rows = await conn.execute_fetchall(
            "SELECT prediction, outcome FROM predictions WHERE ticker=? AND outcome IS NOT NULL",
            (ticker,),
        )
    finally:
        await conn.close()

    total = len(rows)
    if total == 0:
        return {"ticker": ticker, "total": 0, "accuracy": None}

    correct = sum(
        1 for r in rows
        if r["prediction"] == r["outcome"]
        or (r["prediction"] in ("UP", "DOWN") and r["outcome"] != "FLAT"
            and r["prediction"] == r["outcome"])
    )
    abstained = sum(1 for r in rows if r["prediction"] == "ABSTAIN")
    directional = total - abstained

    return {
        "ticker": ticker,
        "total": total,
        "correct": correct,
        "abstained": abstained,
        "directional": directional,
        "accuracy": round(correct / directional, 4) if directional > 0 else None,
    }

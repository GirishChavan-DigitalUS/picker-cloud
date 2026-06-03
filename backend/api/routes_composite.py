"""REST endpoints for composite alert data."""
from __future__ import annotations

from fastapi import APIRouter, Query

from config import PRIMARY_TIMEFRAME, TIMEFRAMES
import db

router = APIRouter()


@router.get("/composite-alerts")
async def get_composite_alerts(
    ticker: str | None = Query(None),
    timeframe: str = Query(PRIMARY_TIMEFRAME, description="Filter by timeframe: '2m' | '5m' | '15m'"),
    limit: int = Query(100, ge=1, le=500),
    latest_cycle_only: bool = Query(True, description="Return only alerts from the most recent refresh cycle"),
):
    if timeframe not in TIMEFRAMES:
        timeframe = PRIMARY_TIMEFRAME
    alerts = await db.get_composite_alerts(
        ticker=ticker, timeframe=timeframe, limit=limit, latest_cycle_only=latest_cycle_only,
    )
    alerts = [a for a in alerts if a.get("tier", 1) < 3]
    return {"alerts": alerts, "count": len(alerts), "timeframe": timeframe}

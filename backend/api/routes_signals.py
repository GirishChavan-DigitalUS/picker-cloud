"""REST endpoints for signal data."""
from __future__ import annotations

from fastapi import APIRouter, Query

import db

router = APIRouter()


@router.get("/signals")
async def get_signals(
    ticker: str | None = Query(None),
    signal_type: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
):
    conn = await db.get_db()
    try:
        conditions = []
        params: list = []
        if ticker:
            conditions.append("ticker = ?")
            params.append(ticker.upper())
        if signal_type:
            conditions.append("signal_type = ?")
            params.append(signal_type)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        params.append(limit)
        rows = await conn.execute_fetchall(
            f"SELECT * FROM signals {where} ORDER BY timestamp DESC LIMIT ?",
            params,
        )
    finally:
        await conn.close()
    return {"signals": [dict(r) for r in rows], "count": len(rows)}

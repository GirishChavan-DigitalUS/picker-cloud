"""
Push notification subscription management API.

Endpoints:
  GET  /api/push/vapid-key     — returns the VAPID public key
  POST /api/push/subscribe     — save a push subscription
  DELETE /api/push/subscribe   — remove a push subscription
"""
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import db
from config import VAPID_PUBLIC_KEY

logger = logging.getLogger(__name__)
router = APIRouter(tags=["push"])


class PushSubscriptionKeys(BaseModel):
    p256dh: str
    auth: str


class PushSubscriptionBody(BaseModel):
    endpoint: str
    keys: PushSubscriptionKeys
    tickers: list[str] | None = None


class UnsubscribeBody(BaseModel):
    endpoint: str


@router.get("/push/vapid-key")
async def get_vapid_key() -> dict[str, Any]:
    if not VAPID_PUBLIC_KEY:
        raise HTTPException(status_code=503, detail="Push notifications not configured on this server")
    return {"publicKey": VAPID_PUBLIC_KEY}


@router.post("/push/subscribe", status_code=201)
async def subscribe(body: PushSubscriptionBody) -> dict[str, str]:
    await db.save_push_subscription(
        endpoint=body.endpoint,
        p256dh=body.keys.p256dh,
        auth=body.keys.auth,
        tickers=body.tickers,
    )
    logger.info("Push subscription saved: %s", body.endpoint[:60])
    return {"status": "subscribed"}


@router.delete("/push/subscribe")
async def unsubscribe(body: UnsubscribeBody) -> dict[str, str]:
    await db.delete_push_subscription(body.endpoint)
    logger.info("Push subscription removed: %s", body.endpoint[:60])
    return {"status": "unsubscribed"}

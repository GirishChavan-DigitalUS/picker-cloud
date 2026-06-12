"""
Web Push notification sender using VAPID (pywebpush).

Call broadcast_push(alert) from the scheduler for Tier 1 & 2 composite alerts.

Cross-TF deduplication: when the same (ticker, signal) fires within
_PUSH_DEDUP_SECS from multiple timeframes (e.g. 2m, then 5m a few minutes
later), only the first push is delivered. This prevents notification spam
for signals that naturally propagate across TFs.
"""
import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

# Cross-TF dedup window (seconds). Suppresses repeat pushes for the same
# (ticker, signal) across TFs within this window.
_PUSH_DEDUP_SECS = 300
_recent_pushes: dict[tuple[str, str], float] = {}


def _is_duplicate_push(ticker: str, signal: str) -> bool:
    """Return True if a push for this (ticker, signal) was sent within the
    dedup window. Records the current send time as a side effect on miss."""
    if not ticker or not signal:
        return False
    key = (ticker, signal)
    now = time.monotonic()
    last = _recent_pushes.get(key)
    if last is not None and (now - last) < _PUSH_DEDUP_SECS:
        return True
    _recent_pushes[key] = now
    # Opportunistic cleanup of stale entries
    if len(_recent_pushes) > 256:
        cutoff = now - _PUSH_DEDUP_SECS
        for k in [k for k, t in _recent_pushes.items() if t < cutoff]:
            _recent_pushes.pop(k, None)
    return False


def _vapid_configured() -> bool:
    from config import VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY
    return bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY)


def send_push_notification(subscription: dict, payload: dict) -> bool:
    """
    Send a single Web Push notification.

    subscription must have keys: endpoint, p256dh, auth
    Returns True on success, False on expected failure (expired/unsubscribed).
    Raises on unexpected errors.
    """
    if not _vapid_configured():
        return False

    from pywebpush import webpush, WebPushException
    from config import VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL

    sub_info = {
        "endpoint": subscription["endpoint"],
        "keys": {
            "p256dh": subscription["p256dh"],
            "auth": subscription["auth"],
        },
    }

    try:
        webpush(
            subscription_info=sub_info,
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": f"mailto:{VAPID_CONTACT_EMAIL}"},
            content_encoding="aes128gcm",
            ttl=300,  # 5 min TTL — stale market alerts are not useful
        )
        return True
    except WebPushException as exc:
        # 404 / 410 = subscription is gone; caller should delete it
        if exc.response is not None and exc.response.status_code in (404, 410):
            return False
        logger.warning("Push send failed for %s: %s", subscription["endpoint"][:60], exc)
        return False


async def broadcast_push(alert: dict[str, Any]) -> None:
    """
    Fan out a push notification to all stored subscriptions.
    Filters by per-subscription ticker list if set.
    Removes subscriptions that return 404/410 (expired).
    Suppresses cross-TF duplicates within _PUSH_DEDUP_SECS.
    """
    if not _vapid_configured():
        return

    import asyncio
    import db

    ticker: str = alert.get("ticker", "")
    signal: str = alert.get("signal", "")
    tier: int = alert.get("tier", 3)
    direction: str = alert.get("direction", "")
    confidence: float = alert.get("ai_confidence", 0.0)
    tf: str = alert.get("timeframe", "")
    price: float | None = alert.get("current_price")

    # Cross-TF dedup — prevents notification spam when the same setup fires
    # on multiple timeframes within a short window.
    if _is_duplicate_push(ticker, signal):
        logger.info("Push deduped: %s %s (tf=%s) within %ds window", ticker, signal, tf, _PUSH_DEDUP_SECS)
        return

    subscriptions = await db.get_all_push_subscriptions()
    if not subscriptions:
        return

    direction_arrow = "▲" if direction == "UP" else "▼" if direction == "DOWN" else "⚠"
    signal_label = signal.replace("_", " ").title()
    tf_suffix = f" [{tf}]" if tf else ""

    price_str = f" @ ${price:,.2f}" if price is not None else ""
    payload = {
        "title": f"Picker {direction_arrow} {ticker}{price_str} — {signal_label}{tf_suffix}",
        "body": f"Tier {tier} · {confidence:.0%} confidence",
        "icon": "/pwa-192.png",
        "badge": "/pwa-192.png",
        "tag": f"picker-{ticker}-{signal}",
        "data": {
            "ticker": ticker,
            "signal": signal,
            "tier": tier,
            "timeframe": tf,
            "price": price,
            "url": f"/?ticker={ticker}",
        },
    }

    expired_endpoints: list[str] = []

    def _send(sub: dict) -> None:
        # Filter by subscribed tickers if the subscription has a preference
        sub_tickers = sub.get("tickers")
        if sub_tickers and ticker not in sub_tickers:
            return
        ok = send_push_notification(sub, payload)
        if not ok:
            expired_endpoints.append(sub["endpoint"])

    loop = asyncio.get_event_loop()
    tasks = [loop.run_in_executor(None, _send, sub) for sub in subscriptions]
    await asyncio.gather(*tasks, return_exceptions=True)

    # Clean up expired subscriptions
    for endpoint in expired_endpoints:
        try:
            await db.delete_push_subscription(endpoint)
            logger.info("Removed expired push subscription: %s", endpoint[:60])
        except Exception:
            pass

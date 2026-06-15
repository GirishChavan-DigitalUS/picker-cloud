"""AWS cost dashboard endpoint.

Surfaces month-to-date AWS spend, last-month comparison, 7-day daily average,
end-of-month projection, configured budget, and threshold alerts. Backed by the
AWS Cost Explorer and Budgets APIs via boto3 — the EC2 instance role must
grant `ce:GetCostAndUsage`, `ce:GetCostForecast`, `budgets:DescribeBudgets`,
`budgets:DescribeNotificationsForBudget`, and `sts:GetCallerIdentity` (see
deploy/cloudformation.yaml).

Cost Explorer is billed at $0.01 per paginated request, so this endpoint
aggressively caches results in-process for `COST_CACHE_TTL` seconds (default
3600 = 1 hour). Use `?refresh=true` to bust the cache.
"""
from __future__ import annotations

import logging
import os
import time
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger(__name__)
router = APIRouter()

_COST_CACHE_TTL = int(os.environ.get("COST_CACHE_TTL", "3600"))
_BUDGET_FALLBACK = float(os.environ.get("AWS_MONTHLY_BUDGET", "10"))
_ALERT_THRESHOLD_PCT = float(os.environ.get("AWS_BUDGET_ALERT_PCT", "80"))
_AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

_cache: dict[str, tuple[float, dict]] = {}


def _today_utc() -> date:
    return datetime.now(timezone.utc).date()


def _safe_float(val) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return 0.0


def _prev_month(today: date) -> tuple[date, date, int]:
    """Return (first_day_prev_month, first_day_this_month, days_in_prev_month)."""
    first_this = today.replace(day=1)
    last_prev = first_this - timedelta(days=1)
    first_prev = last_prev.replace(day=1)
    return first_prev, first_this, last_prev.day


def _load_summary() -> dict:
    """Synchronous boto3 calls; wrapped in a thread by FastAPI default executor."""
    try:
        import boto3  # type: ignore
        from botocore.exceptions import BotoCoreError, ClientError  # type: ignore
    except ImportError as exc:
        raise HTTPException(503, f"boto3 not installed on backend: {exc}")

    today = _today_utc()
    # CE TimePeriod is half-open [Start, End) and requires End > Start strictly.
    # Use tomorrow as the exclusive upper bound so day-1-of-month MTD windows
    # (e.g. Jun 1 → Jun 1) are still valid and include today's partial data.
    tomorrow = today + timedelta(days=1)
    month_start = today.replace(day=1).isoformat()
    today_iso = today.isoformat()
    tomorrow_iso = tomorrow.isoformat()
    days_in_month = monthrange(today.year, today.month)[1]
    days_elapsed = max(1, today.day)  # avoid /0 on the 1st
    currency = "USD"

    # Cost Explorer endpoint is global, pinned to us-east-1
    ce = boto3.client("ce", region_name="us-east-1")

    # --- MTD spend, grouped by service ---
    try:
        resp = ce.get_cost_and_usage(
            TimePeriod={"Start": month_start, "End": tomorrow_iso},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}],
        )
    except (BotoCoreError, ClientError) as exc:
        logger.warning("Cost Explorer GetCostAndUsage failed: %s", exc)
        raise HTTPException(502, "Unable to fetch cost data. Please try again later.")

    mtd_total = 0.0
    by_service: list[dict] = []
    for grp in (resp.get("ResultsByTime") or [{}])[0].get("Groups", []):
        keys = grp.get("Keys") or ["Other"]
        metric = grp.get("Metrics", {}).get("UnblendedCost", {})
        amount = _safe_float(metric.get("Amount"))
        currency = metric.get("Unit", currency)
        if amount <= 0:
            continue
        by_service.append({"service": keys[0], "amount": round(amount, 2)})
        mtd_total += amount
    by_service.sort(key=lambda s: s["amount"], reverse=True)

    # --- Last-month total (same window, for the % delta card) ---
    last_month_total = 0.0
    last_month_same_day_total = 0.0
    vs_last_month_pct: float | None = None
    try:
        first_prev, first_this, days_in_prev = _prev_month(today)
        # Full previous month
        prev_resp = ce.get_cost_and_usage(
            TimePeriod={"Start": first_prev.isoformat(), "End": first_this.isoformat()},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
        )
        for r in prev_resp.get("ResultsByTime", []):
            last_month_total += _safe_float(r.get("Total", {}).get("UnblendedCost", {}).get("Amount"))

        # Equivalent days-elapsed slice of last month (apples-to-apples MTD comparison).
        # End is exclusive; bump by +1 day so a 1-day slice (day 1 of current month)
        # is still a valid non-empty window. Cap at first_this so we never spill
        # into the current month.
        cmp_end_day = min(days_elapsed, days_in_prev)
        cmp_end = min(first_prev.replace(day=cmp_end_day) + timedelta(days=1), first_this)
        cmp_resp = ce.get_cost_and_usage(
            TimePeriod={"Start": first_prev.isoformat(), "End": cmp_end.isoformat()},
            Granularity="MONTHLY",
            Metrics=["UnblendedCost"],
        )
        for r in cmp_resp.get("ResultsByTime", []):
            last_month_same_day_total += _safe_float(r.get("Total", {}).get("UnblendedCost", {}).get("Amount"))

        if last_month_same_day_total > 0:
            vs_last_month_pct = round(
                (mtd_total - last_month_same_day_total) / last_month_same_day_total * 100, 1
            )
    except (BotoCoreError, ClientError) as exc:
        logger.info("Last-month comparison unavailable: %s", exc)

    # --- Daily avg over last 7 days (rolling window) ---
    daily_avg_7d = mtd_total / days_elapsed  # fallback if 7d call fails
    try:
        window_start = (today - timedelta(days=7)).isoformat()
        daily_resp = ce.get_cost_and_usage(
            TimePeriod={"Start": window_start, "End": today_iso},
            Granularity="DAILY",
            Metrics=["UnblendedCost"],
        )
        rows = daily_resp.get("ResultsByTime", [])
        if rows:
            daily_total = sum(
                _safe_float(r.get("Total", {}).get("UnblendedCost", {}).get("Amount")) for r in rows
            )
            daily_avg_7d = daily_total / len(rows)
    except (BotoCoreError, ClientError) as exc:
        logger.info("7-day avg fallback to MTD-avg: %s", exc)

    # --- Forecast / projection ---
    projected_month = mtd_total + daily_avg_7d * max(0, days_in_month - days_elapsed)
    try:
        month_end_excl = date(today.year + (1 if today.month == 12 else 0),
                              1 if today.month == 12 else today.month + 1, 1)
        if today < month_end_excl:
            fc = ce.get_cost_forecast(
                TimePeriod={"Start": today_iso, "End": month_end_excl.isoformat()},
                Metric="UNBLENDED_COST",
                Granularity="MONTHLY",
            )
            forecast_remaining = _safe_float(fc.get("Total", {}).get("Amount"))
            if forecast_remaining > 0:
                projected_month = mtd_total + forecast_remaining
    except (BotoCoreError, ClientError) as exc:
        # Forecast often unavailable for new accounts (needs ~14 days of history)
        logger.info("Cost Forecast unavailable (using 7-day-avg projection): %s", exc)

    # --- Budget (AWS Budgets first, env-var fallback) + threshold alerts ---
    budget_amount = _BUDGET_FALLBACK
    budget_source = "env"
    budget_name: str | None = None
    alert_threshold_pct = _ALERT_THRESHOLD_PCT
    alerts: list[dict] = []
    try:
        sts = boto3.client("sts", region_name=_AWS_REGION)
        account_id = sts.get_caller_identity()["Account"]
        budgets_cli = boto3.client("budgets", region_name="us-east-1")
        b_resp = budgets_cli.describe_budgets(AccountId=account_id, MaxResults=100)
        for b in b_resp.get("Budgets", []):
            if b.get("BudgetType") != "COST":
                continue
            limit = b.get("BudgetLimit", {})
            amt = _safe_float(limit.get("Amount"))
            if amt <= 0:
                continue
            budget_amount = amt
            currency = limit.get("Unit", currency)
            budget_name = b.get("BudgetName")
            budget_source = f"aws:{budget_name}"

            # Pull threshold notifications for this budget
            try:
                notif_resp = budgets_cli.describe_notifications_for_budget(
                    AccountId=account_id, BudgetName=budget_name
                )
                thresholds = sorted(
                    {
                        _safe_float(n.get("Threshold"))
                        for n in notif_resp.get("Notifications", [])
                        if n.get("NotificationType") == "ACTUAL"
                    }
                )
                if thresholds:
                    alert_threshold_pct = thresholds[-1]  # highest configured threshold
            except (BotoCoreError, ClientError):
                pass
            break
    except (BotoCoreError, ClientError, KeyError) as exc:
        logger.info("Budgets lookup failed, using env fallback: %s", exc)

    budget_pct_used = (mtd_total / budget_amount * 100) if budget_amount > 0 else 0.0
    projected_pct = (projected_month / budget_amount * 100) if budget_amount > 0 else 0.0

    # --- Generate human-readable alerts ---
    if projected_pct >= alert_threshold_pct:
        alerts.append({
            "severity": "warning",
            "message": (
                f"{int(alert_threshold_pct)}% threshold approaching — projected spend of "
                f"${projected_month:.2f} may hit your ${budget_amount:.0f} budget"
            ),
        })
    if budget_pct_used >= 100:
        alerts.append({
            "severity": "critical",
            "message": f"Budget exceeded — MTD spend ${mtd_total:.2f} is over ${budget_amount:.0f}",
        })
    elif budget_pct_used >= alert_threshold_pct:
        alerts.append({
            "severity": "critical",
            "message": f"Actual spend has crossed {int(alert_threshold_pct)}% of monthly budget",
        })
    if vs_last_month_pct is not None and vs_last_month_pct >= 25:
        alerts.append({
            "severity": "warning",
            "message": f"Spend is up {vs_last_month_pct:.0f}% vs the same period last month",
        })
    if 50 <= budget_pct_used < alert_threshold_pct:
        alerts.append({
            "severity": "info",
            "message": f"50% threshold cleared — currently at {budget_pct_used:.0f}% of budget",
        })

    return {
        "month": today.strftime("%Y-%m"),
        "month_label": today.strftime("%B %Y").upper(),
        "mtd_spend": round(mtd_total, 2),
        "vs_last_month_pct": vs_last_month_pct,
        "last_month_total": round(last_month_total, 2),
        "daily_avg": round(mtd_total / days_elapsed, 2),
        "daily_avg_7d": round(daily_avg_7d, 2),
        "days_elapsed": days_elapsed,
        "days_in_month": days_in_month,
        "projected_month": round(projected_month, 2),
        "budget": round(budget_amount, 2),
        "budget_source": budget_source,
        "budget_name": budget_name,
        "budget_pct_used": round(budget_pct_used, 1),
        "projected_pct": round(projected_pct, 1),
        "alert_threshold_pct": round(alert_threshold_pct, 1),
        "currency": currency,
        "by_service": by_service[:10],
        "alerts": alerts,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/costs/summary")
async def get_cost_summary(refresh: bool = Query(False)):
    """Return an aggregated AWS cost snapshot for the current month.

    Cached for `COST_CACHE_TTL` seconds. Pass `?refresh=true` to force a fresh
    call (still rate-limited to once per 60 seconds to protect against runaway
    Cost Explorer charges).
    """
    import asyncio

    now = time.monotonic()
    cached = _cache.get("summary")
    if cached and not refresh and (now - cached[0]) < _COST_CACHE_TTL:
        payload = dict(cached[1])
        payload["cached"] = True
        payload["cache_age_seconds"] = int(now - cached[0])
        return payload

    if cached and refresh and (now - cached[0]) < 60:
        payload = dict(cached[1])
        payload["cached"] = True
        payload["cache_age_seconds"] = int(now - cached[0])
        payload["refresh_throttled"] = True
        return payload

    try:
        data = await asyncio.to_thread(_load_summary)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("cost summary load failed")
        raise HTTPException(500, f"Cost summary error: {exc}")

    _cache["summary"] = (now, data)
    payload = dict(data)
    payload["cached"] = False
    payload["cache_age_seconds"] = 0
    return payload

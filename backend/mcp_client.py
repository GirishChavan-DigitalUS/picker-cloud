"""
yFinance-based market data fetcher — replaces the TradingView MCP client.

Fetches 5-minute OHLCV bars for NYSE tickers via Yahoo Finance (yfinance).
Includes premarket (4 AM ET) through after-hours (8 PM ET).
Falls back to the most recent NYSE session if today is a weekend or holiday.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, timedelta

import pandas as pd
import yfinance as yf

from config import classify_session, ET, TIMEFRAMES

logger = logging.getLogger(__name__)

# Yahoo Finance symbol overrides
YF_SYMBOL_MAP: dict[str, str] = {
    "SPX": "^GSPC",   # S&P 500 index
}

# NYSE premarket start hour in ET
_PM_START_HOUR = 4   # 4:00 AM ET


def yf_symbol(ticker: str) -> str:
    return YF_SYMBOL_MAP.get(ticker, ticker)


class YFinanceFetcher:
    """Drop-in replacement for TradingViewMCPClient using yfinance."""

    def is_connected(self) -> bool:
        return True  # yfinance is always "connected"

    async def connect(self) -> None:
        logger.info("yFinance fetcher ready (no external connection required)")

    async def disconnect(self) -> None:
        pass

    async def reconnect(self) -> None:
        pass

    async def fetch_ticker(
        self, ticker: str, limit: int = 400, tf: str = "2m"
    ) -> tuple[pd.DataFrame, float]:
        """
        Fetch OHLCV bars for the requested timeframe (`tf`) from 4 AM ET
        (premarket) through the current bar, PLUS the previous trading day's
        regular session for prev-day high/low.
        Returns (df, current_price).
        """
        if tf not in TIMEFRAMES:
            raise ValueError(f"Unsupported timeframe: {tf!r}. Expected one of {list(TIMEFRAMES)}")
        tf_cfg = TIMEFRAMES[tf]
        sym = yf_symbol(ticker)
        loop = asyncio.get_event_loop()
        df_raw = await loop.run_in_executor(
            None, _fetch_sync, sym, tf_cfg["yf_interval"], tf_cfg["yf_period"]
        )

        if df_raw is None or df_raw.empty:
            return pd.DataFrame(), 0.0

        # Normalise index to UTC-aware
        idx = df_raw.index
        if idx.tz is None:
            idx = idx.tz_localize("UTC")
        else:
            idx = idx.tz_convert("UTC")
        df_raw = df_raw.copy()
        df_raw.index = idx

        idx_et = idx.tz_convert(ET)

        # Most recent trading date in the data
        trading_date = idx_et.normalize().max().date()

        # Previous trading date (skip weekends; ignores holidays but good enough)
        prev_date = trading_date - timedelta(days=1)
        while prev_date.weekday() >= 5:
            prev_date -= timedelta(days=1)

        # Window: from yesterday's regular open through today's last bar
        # Today: from 4 AM ET
        today_start = pd.Timestamp(trading_date, tz=ET).replace(hour=_PM_START_HOUR, minute=0)  # noqa: kept for reference
        # Prev day: from 9:30 AM ET (regular session start)
        prev_start = pd.Timestamp(prev_date, tz=ET).replace(hour=9, minute=30)

        mask = idx_et >= prev_start
        window_raw = df_raw[mask]

        if window_raw.empty:
            window_raw = df_raw

        current_price = float(window_raw["Close"].iloc[-1])

        window_idx_et = window_raw.index.tz_convert(ET)
        df = pd.DataFrame({
            "timestamp": window_raw.index,
            "open":   window_raw["Open"].values.astype(float),
            "high":   window_raw["High"].values.astype(float),
            "low":    window_raw["Low"].values.astype(float),
            "close":  window_raw["Close"].values.astype(float),
            "volume": window_raw["Volume"].values.astype(float),
        })

        df["session"] = [classify_session(ts) for ts in window_idx_et]
        df["timeframe"] = tf

        # ------------------------------------------------------------------
        # Clip extreme wicks on pre/after-hours candles.
        # yfinance sometimes returns a single stale trade that spikes the
        # high or low by 5-20%, completely blowing up the chart y-axis.
        # Cap high/low so that no off-hours candle can deviate more than
        # _OFFHOURS_MAX_RANGE from its close price.
        # ------------------------------------------------------------------
        _OFFHOURS_MAX_RANGE = 0.04  # 4 % of close — catches the worst outliers
        mask_off = df["session"].isin(["pre", "after"])
        if mask_off.any():
            cl = df.loc[mask_off, "close"]
            df.loc[mask_off, "high"] = df.loc[mask_off, "high"].clip(upper=cl * (1 + _OFFHOURS_MAX_RANGE))
            df.loc[mask_off, "low"]  = df.loc[mask_off, "low"].clip(lower=cl * (1 - _OFFHOURS_MAX_RANGE))
            # Ensure open is also within range (rare but possible with adjusted data)
            df.loc[mask_off, "open"] = df.loc[mask_off, "open"].clip(
                lower=cl * (1 - _OFFHOURS_MAX_RANGE),
                upper=cl * (1 + _OFFHOURS_MAX_RANGE),
            )

        # Mark bars before today as prev_day so the DB doesn't mix sessions
        df["is_today"] = window_raw.index.tz_convert(ET).normalize() == pd.Timestamp(trading_date, tz=ET).normalize()
        df["timestamp"] = df["timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")

        df = df.tail(limit).reset_index(drop=True)
        return df, current_price


def _fetch_sync(sym: str, interval: str = "2m", period: str = "5d") -> pd.DataFrame | None:
    """Synchronous yfinance download — executed in a thread executor."""
    try:
        t = yf.Ticker(sym)
        df = t.history(period=period, interval=interval, auto_adjust=True, prepost=True)
        if df.empty:
            logger.warning("[%s] yfinance returned empty DataFrame (interval=%s period=%s)", sym, interval, period)
            return None
        return df
    except Exception as exc:
        logger.error("[%s] yfinance fetch error (interval=%s period=%s): %s", sym, interval, period, exc)
        return None


# ---------------------------------------------------------------------------
# Singleton — imported by scheduler.py and main.py
# ---------------------------------------------------------------------------
tv_mcp = YFinanceFetcher()


async def connect_with_backoff(fetcher: YFinanceFetcher) -> None:
    """No-op — kept for API compatibility with old scheduler imports."""
    await fetcher.connect()


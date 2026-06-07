"""
Confluence Level Calculator: POC/VAL/VAH + Pivot Analysis

Combines volume profile (POC/VAL/VAH) with standard pivots (S1/S2/R1/R2)
for multi-timeframe confluence detection.

Refresh schedule:
- Daily: every refresh cycle during market hours
- Weekly: first trading day of week (Monday or market open)
- Monthly: first trading day of month
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
import numpy as np
import pandas as pd
import yfinance as yf

from config import ET

logger = logging.getLogger(__name__)


class ConfluenceAnalyzer:
    """Calculate and cache POC/VAL/VAH and pivot levels across timeframes."""

    def __init__(self):
        self.cache = {}  # {(ticker, timeframe): {...levels}}

    def should_refresh_daily(self) -> bool:
        """Always refresh during market hours (for current day data)."""
        from config import is_regular_hours
        return is_regular_hours()

    def should_refresh_weekly(self) -> bool:
        """Refresh only on Monday or if it's the first trading day of week."""
        now_et = datetime.now(timezone.utc).astimezone(ET)
        # Monday = 0
        return now_et.weekday() == 0

    def should_refresh_monthly(self) -> bool:
        """Refresh only on 1st of month or if it's the first trading day of month."""
        now_et = datetime.now(timezone.utc).astimezone(ET)
        return now_et.day == 1

    def get_or_refresh_levels(self, ticker: str, timeframe: str) -> dict:
        """
        Get cached confluence levels or refresh if schedule dictates.
        
        Args:
            ticker: stock symbol (e.g., 'SPY')
            timeframe: 'daily', 'weekly', or 'monthly'
        
        Returns:
            dict with keys: poc, val, vah, pivot, s1, s2, r1, r2, timestamp, patterns
        """
        key = (ticker.upper(), timeframe)

        # Check if refresh needed
        should_refresh = False
        if timeframe == "daily":
            should_refresh = self.should_refresh_daily()
        elif timeframe == "weekly":
            should_refresh = self.should_refresh_weekly()
        elif timeframe == "monthly":
            should_refresh = self.should_refresh_monthly()

        if should_refresh or key not in self.cache:
            try:
                levels = self._pull_and_calculate(ticker, timeframe)
                self.cache[key] = levels
                logger.info(f"Refreshed {timeframe} levels for {ticker}")
            except Exception as e:
                logger.error(f"Failed to refresh {timeframe} levels for {ticker}: {e}")
                # Return cached if available, else empty
                if key in self.cache:
                    return self.cache[key]
                return self._empty_levels()
        else:
            logger.debug(f"Using cached {timeframe} levels for {ticker}")

        return self.cache[key]

    def _pull_and_calculate(self, ticker: str, timeframe: str) -> dict:
        """Pull data from yfinance and calculate levels."""
        ticker = ticker.upper()
        candles = self._fetch_candles(ticker, timeframe)

        if candles.empty:
            return self._empty_levels()

        # Calculate volume profile (POC, VAL, VAH)
        poc, val, vah = self._calc_volume_profile(candles)

        # Calculate pivots from the period's high/low/close
        pivot, s1, s2, r1, r2 = self._calc_pivots(candles)

        return {
            "poc": poc,
            "val": val,
            "vah": vah,
            "pivot": pivot,
            "s1": s1,
            "s2": s2,
            "r1": r1,
            "r2": r2,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "timeframe": timeframe,
        }

    def _fetch_candles(self, ticker: str, timeframe: str) -> pd.DataFrame:
        """Fetch daily candles for the requested period from yfinance."""
        ticker = ticker.upper()
        now_et = datetime.now(timezone.utc).astimezone(ET)

        if timeframe == "daily":
            # Today's candles only
            start = now_et.date()
            end = now_et.date() + timedelta(days=1)
        elif timeframe == "weekly":
            # Previous week (Mon-Fri) or current week if Monday
            # Find last Monday
            days_since_monday = now_et.weekday()
            if days_since_monday == 0:
                # Today is Monday, get previous week
                start = (now_et - timedelta(days=7)).date()
            else:
                # Get this week's Monday
                start = (now_et - timedelta(days=days_since_monday)).date()
            end = start + timedelta(days=7)
        elif timeframe == "monthly":
            # Previous month or current month if 1st
            if now_et.day == 1:
                # Today is 1st, get previous month
                start = (now_et.replace(day=1) - timedelta(days=1)).replace(day=1)
            else:
                # Get this month's 1st
                start = now_et.replace(day=1)
            # Get last day of month
            next_month = start.replace(day=28) + timedelta(days=4)
            end = next_month - timedelta(days=next_month.day)
            end = end + timedelta(days=1)
        else:
            return pd.DataFrame()

        # Fetch daily bars
        try:
            df = yf.download(ticker, start=start, end=end, interval="1d", progress=False)
            if df.empty:
                return df
            df.reset_index(inplace=True)
            df.columns = [c.lower() for c in df.columns]
            return df
        except Exception as e:
            logger.error(f"yfinance download failed for {ticker} ({timeframe}): {e}")
            return pd.DataFrame()

    def _calc_volume_profile(self, df: pd.DataFrame) -> tuple[float | None, float | None, float | None]:
        """
        Calculate POC, VAL, VAH from volume profile.
        
        Returns: (poc, val, vah)
        """
        if df.empty or "volume" not in df.columns:
            return None, None, None

        df = df.copy()

        # Use 50 price bins for the profile
        num_bins = 50
        price_min = float(df["low"].min())
        price_max = float(df["high"].max())

        if price_min >= price_max:
            mid = (price_min + price_max) / 2
            return round(mid, 4), round(mid, 4), round(mid, 4)

        bins = np.linspace(price_min, price_max, num_bins + 1)
        bin_volume = np.zeros(num_bins)

        # Distribute each candle's volume across bins it touches
        for _, row in df.iterrows():
            bar_bins = np.where((bins[:-1] <= row["high"]) & (bins[1:] >= row["low"]))[0]
            if len(bar_bins) > 0:
                bin_volume[bar_bins] += row["volume"] / len(bar_bins)

        # POC = bin with highest volume
        poc_idx = int(np.argmax(bin_volume))
        poc = (bins[poc_idx] + bins[poc_idx + 1]) / 2.0

        # VAL/VAH = value area (70% of total volume)
        total_vol = bin_volume.sum()
        target_vol = total_vol * 0.70

        # Find highest POC and expand around it to reach 70%
        cumulative_vol = 0
        sorted_bins = sorted(range(num_bins), key=lambda i: bin_volume[i], reverse=True)

        covered_bins = set()
        for bin_idx in sorted_bins:
            covered_bins.add(bin_idx)
            cumulative_vol += bin_volume[bin_idx]
            if cumulative_vol >= target_vol:
                break

        if covered_bins:
            val_idx = min(covered_bins)
            vah_idx = max(covered_bins)
            val = bins[val_idx]
            vah = bins[vah_idx + 1]
        else:
            val = poc
            vah = poc

        return (
            round(poc, 4),
            round(val, 4),
            round(vah, 4),
        )

    def _calc_pivots(self, df: pd.DataFrame) -> tuple[float | None, float | None, float | None, float | None, float | None]:
        """
        Calculate pivot points and support/resistance levels.
        Uses standard pivot formula:
        Pivot = (H + L + C) / 3
        R1 = (Pivot * 2) - L
        S1 = (Pivot * 2) - H
        R2 = Pivot + (H - L)
        S2 = Pivot - (H - L)
        
        Returns: (pivot, s1, s2, r1, r2)
        """
        if df.empty:
            return None, None, None, None, None

        high = float(df["high"].max())
        low = float(df["low"].min())
        close = float(df["close"].iloc[-1])

        pivot = (high + low + close) / 3.0
        r1 = (pivot * 2) - low
        r2 = pivot + (high - low)
        s1 = (pivot * 2) - high
        s2 = pivot - (high - low)

        return (
            round(pivot, 4),
            round(s1, 4),
            round(s2, 4),
            round(r1, 4),
            round(r2, 4),
        )

    def detect_patterns(self, current_price: float, levels: dict) -> dict:
        """
        Detect confluence patterns: breakout, rejection, mean reversion, etc.
        
        Args:
            current_price: current market price
            levels: dict with all timeframe levels
        
        Returns:
            dict with detected patterns, narrative, and fusion score
        """
        patterns = {
            "daily": self._detect_pattern_for_level(current_price, levels.get("daily", {})),
            "weekly": self._detect_pattern_for_level(current_price, levels.get("weekly", {})),
            "monthly": self._detect_pattern_for_level(current_price, levels.get("monthly", {})),
        }
        
        # Overall confluence score
        patterns["confluence_strength"] = self._calc_confluence_strength(levels)
        
        # Multi-timeframe bias narrative
        patterns["bias_narrative"] = self._generate_bias_narrative(current_price, levels)
        
        # Zone touch detection
        patterns["zone_touches"] = self._detect_zone_touches(current_price, levels)
        
        return patterns

    def _detect_pattern_for_level(self, price: float, level_dict: dict) -> dict:
        """Detect pattern for a single timeframe level."""
        if not level_dict:
            return {"status": "no_data"}

        poc = level_dict.get("poc")
        val = level_dict.get("val")
        vah = level_dict.get("vah")
        pivot = level_dict.get("pivot")
        s1 = level_dict.get("s1")
        s2 = level_dict.get("s2")
        r1 = level_dict.get("r1")
        r2 = level_dict.get("r2")

        if not all([poc, val, vah, pivot, s1, s2, r1, r2]):
            return {"status": "incomplete_data"}

        # Check distance from key levels (tolerance: 0.5%)
        tolerance = 0.005

        # Breakout detection
        if price > r2 * (1 + tolerance):
            return {"pattern": "BREAKOUT_UP", "level": r2, "severity": "high"}
        if price > r1 * (1 + tolerance):
            return {"pattern": "BREAKOUT_UP", "level": r1, "severity": "medium"}

        if price < s2 * (1 - tolerance):
            return {"pattern": "BREAKOUT_DOWN", "level": s2, "severity": "high"}
        if price < s1 * (1 - tolerance):
            return {"pattern": "BREAKOUT_DOWN", "level": s1, "severity": "medium"}

        # Rejection (price near level but reversing)
        if abs(price - r2) / r2 < tolerance:
            return {"pattern": "REJECTION_DOWN", "level": r2, "severity": "medium"}
        if abs(price - r1) / r1 < tolerance:
            return {"pattern": "REJECTION_DOWN", "level": r1, "severity": "low"}

        if abs(price - s2) / s2 < tolerance:
            return {"pattern": "REJECTION_UP", "level": s2, "severity": "medium"}
        if abs(price - s1) / s1 < tolerance:
            return {"pattern": "REJECTION_UP", "level": s1, "severity": "low"}

        # Mean reversion (price at VAL/VAH)
        if abs(price - vah) / vah < tolerance:
            return {"pattern": "WATCH_RESISTANCE", "level": vah, "severity": "low"}
        if abs(price - val) / val < tolerance:
            return {"pattern": "WATCH_SUPPORT", "level": val, "severity": "low"}

        # POC test
        if abs(price - poc) / poc < tolerance:
            return {"pattern": "POC_TEST", "level": poc, "severity": "low"}

        # Generic confluence zone
        if val < price < vah:
            return {"pattern": "IN_VALUE_AREA", "level": (val + vah) / 2, "severity": "low"}

        return {"pattern": "NO_PATTERN", "level": price, "severity": "none"}

    def _calc_confluence_strength(self, levels: dict) -> str:
        """
        Calculate overall confluence strength.
        
        Returns: "HIGH", "MEDIUM", "LOW", or "NONE"
        """
        if not levels:
            return "NONE"

        score = 0

        # Score based on patterns detected
        for timeframe, tf_levels in levels.items():
            if not tf_levels or not isinstance(tf_levels, dict):
                continue
            
            # Check for multiple level proximity
            daily_levels = levels.get("daily", {})
            weekly_levels = levels.get("weekly", {})
            monthly_levels = levels.get("monthly", {})

            if all([daily_levels, weekly_levels, monthly_levels]):
                # Multi-timeframe alignment = high confluence
                score += 2

        return "HIGH" if score >= 2 else "MEDIUM" if score >= 1 else "LOW"

    def _generate_bias_narrative(self, current_price: float, levels: dict) -> str:
        """
        Generate multi-timeframe bias narrative.
        E.g., "Monthly bullish (above pivot), Weekly breakout forming, Daily support tested"
        
        Returns: Short narrative string (1-2 sentences)
        """
        if not levels or not current_price:
            return "Insufficient data"

        daily = levels.get("daily", {})
        weekly = levels.get("weekly", {})
        monthly = levels.get("monthly", {})

        parts = []

        # Monthly bias
        if monthly and monthly.get("pivot"):
            pivot_m = monthly.get("pivot")
            if current_price > pivot_m:
                parts.append("Monthly bullish (above pivot)")
            else:
                parts.append("Monthly bearish (below pivot)")

        # Weekly bias
        if weekly and weekly.get("pivot"):
            pivot_w = weekly.get("pivot")
            r1_w = weekly.get("r1")
            s1_w = weekly.get("s1")
            if current_price > r1_w:
                parts.append("Weekly breakout up")
            elif current_price < s1_w:
                parts.append("Weekly breakdown down")
            elif current_price > pivot_w:
                parts.append("Weekly recovery")
            else:
                parts.append("Weekly weakness")

        # Daily bias
        if daily and daily.get("poc"):
            poc_d = daily.get("poc")
            vah_d = daily.get("vah")
            val_d = daily.get("val")
            if current_price > vah_d:
                parts.append("Daily above value area")
            elif current_price < val_d:
                parts.append("Daily below value area")
            elif current_price > poc_d:
                parts.append("Daily in upper value")
            else:
                parts.append("Daily in lower value")

        return " | ".join(parts) if parts else "Neutral bias"

    def _detect_zone_touches(self, current_price: float, levels: dict) -> dict:
        """
        Detect if price is touching or near key confluence zones.
        Returns dict with touches and their severity.
        """
        touches = {}
        tolerance = 0.008  # 0.8% tolerance for "touching"

        for timeframe in ["daily", "weekly", "monthly"]:
            tf_levels = levels.get(timeframe, {})
            if not tf_levels:
                continue

            for level_name in ["poc", "val", "vah", "pivot", "s1", "s2", "r1", "r2"]:
                level_val = tf_levels.get(level_name)
                if level_val is None:
                    continue

                distance_pct = abs(current_price - level_val) / level_val
                if distance_pct < tolerance:
                    key = f"{timeframe}_{level_name}"
                    touches[key] = {
                        "level": level_val,
                        "timeframe": timeframe,
                        "name": level_name.upper(),
                        "distance_pct": round(distance_pct * 100, 3),
                    }

        return touches if touches else {}

    def calc_fusion_score(self, current_price: float, levels: dict, ai_prediction: str = None, ai_confidence: float = None) -> dict:
        """
        Calculate fusion score combining confluence alignment + AI prediction.
        
        Args:
            current_price: current price
            levels: confluence levels
            ai_prediction: 'UP', 'DOWN', 'NEUTRAL', 'ABSTAIN'
            ai_confidence: 0-1 confidence score
        
        Returns:
            dict with fusion_score (0-100), fusion_signal, confidence
        """
        if not current_price or not levels:
            return {
                "fusion_score": 0,
                "fusion_signal": "INSUFFICIENT_DATA",
                "reasoning": "No price or levels",
            }

        # Base score from confluence strength
        strength = self._calc_confluence_strength(levels)
        base_score = {"HIGH": 70, "MEDIUM": 50, "LOW": 30, "NONE": 0}.get(strength, 0)

        # Bonus for AI agreement
        ai_score = 0
        ai_reasoning = ""
        if ai_prediction and ai_confidence:
            if ai_prediction in ["UP", "DOWN"]:
                ai_score = min(30, int(ai_confidence * 30))
                ai_reasoning = f" + {ai_score} AI ({ai_prediction} {int(ai_confidence*100)}%)"

        total_score = min(100, base_score + ai_score)

        # Determine signal
        if ai_prediction == "UP" and total_score >= 60:
            signal = "STRONG_BUY"
        elif ai_prediction == "UP" and total_score >= 40:
            signal = "BUY"
        elif ai_prediction == "DOWN" and total_score >= 60:
            signal = "STRONG_SELL"
        elif ai_prediction == "DOWN" and total_score >= 40:
            signal = "SELL"
        elif total_score >= 70:
            signal = "STRONG_CONFLUENCE"
        elif total_score >= 50:
            signal = "WATCH"
        else:
            signal = "NEUTRAL"

        return {
            "fusion_score": total_score,
            "fusion_signal": signal,
            "base_confluence_score": base_score,
            "ai_bonus_score": ai_score,
            "reasoning": f"Confluence {strength}{ai_reasoning}",
        }

    def _empty_levels(self) -> dict:
        """Return empty/null levels dict."""
        return {
            "poc": None,
            "val": None,
            "vah": None,
            "pivot": None,
            "s1": None,
            "s2": None,
            "r1": None,
            "r2": None,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "timeframe": None,
        }

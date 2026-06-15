"""REST endpoints for confluence level analysis."""
from __future__ import annotations

from fastapi import APIRouter, Query
import logging

from ai.confluence_engine import ConfluenceAnalyzer
import db

router = APIRouter()
logger = logging.getLogger(__name__)

# Global analyzer instance
_analyzer = ConfluenceAnalyzer()


@router.get("/confluence/batch")
async def get_confluence_batch(
    tickers: str = Query(..., description="Comma-separated ticker symbols"),
):
    """
    Batch fetch confluence strength for multiple tickers in a single request.
    Returns a dict of ticker → confluence_strength (or null).
    """
    ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    results: dict[str, str | None] = {}

    for ticker in ticker_list:
        try:
            levels = {
                "daily": _analyzer.get_or_refresh_levels(ticker, "daily"),
                "weekly": _analyzer.get_or_refresh_levels(ticker, "weekly"),
                "monthly": _analyzer.get_or_refresh_levels(ticker, "monthly"),
            }
            patterns = _analyzer.detect_patterns(0, levels)  # price=0 → strength only
            results[ticker] = patterns.get("confluence_strength") if patterns else None
        except Exception:
            results[ticker] = None

    return {"strengths": results}


@router.get("/confluence/{ticker}")
async def get_confluence_levels(
    ticker: str,
    current_price: float = Query(None, description="Optional current price for pattern detection"),
    ai_prediction: str = Query(None, description="Optional AI prediction: UP|DOWN|NEUTRAL|ABSTAIN"),
    ai_confidence: float = Query(None, description="Optional AI confidence 0-1"),
):
    """
    Get multi-timeframe confluence levels (daily, weekly, monthly).
    
    Levels are cached and only refreshed on schedule:
    - Daily: every market hour
    - Weekly: first trading day of week (Monday)
    - Monthly: first trading day of month
    
    Optional: provide AI prediction for fusion scoring.
    
    Returns levels, patterns, bias narrative, zone touches, and fusion score.
    """
    ticker = ticker.upper()

    try:
        levels = {
            "daily": _analyzer.get_or_refresh_levels(ticker, "daily"),
            "weekly": _analyzer.get_or_refresh_levels(ticker, "weekly"),
            "monthly": _analyzer.get_or_refresh_levels(ticker, "monthly"),
        }

        # Detect patterns if current price provided
        patterns = None
        fusion_score = None
        
        if current_price is not None:
            patterns = _analyzer.detect_patterns(current_price, levels)
            
            # Calculate fusion score with AI if provided
            if ai_prediction and ai_confidence is not None:
                fusion_score = _analyzer.calc_fusion_score(
                    current_price,
                    levels,
                    ai_prediction=ai_prediction,
                    ai_confidence=ai_confidence,
                )

        return {
            "ticker": ticker,
            "current_price": current_price,
            "levels": levels,
            "patterns": patterns,
            "fusion_score": fusion_score,
        }
    except Exception as e:
        logger.error(f"Error fetching confluence levels for {ticker}: {e}")
        return {
            "ticker": ticker,
            "error": str(e),
            "levels": None,
            "patterns": None,
            "fusion_score": None,
        }


@router.get("/confluence/{ticker}/patterns")
async def get_patterns_only(
    ticker: str,
    current_price: float = Query(..., description="Current market price"),
):
    """
    Quick endpoint to detect patterns without full level data.
    Requires current_price as query parameter.
    """
    ticker = ticker.upper()

    try:
        levels = {
            "daily": _analyzer.get_or_refresh_levels(ticker, "daily"),
            "weekly": _analyzer.get_or_refresh_levels(ticker, "weekly"),
            "monthly": _analyzer.get_or_refresh_levels(ticker, "monthly"),
        }

        patterns = _analyzer.detect_patterns(current_price, levels)

        return {
            "ticker": ticker,
            "current_price": current_price,
            "patterns": patterns,
        }
    except Exception as e:
        logger.error(f"Error detecting patterns for {ticker}: {e}")
        return {
            "ticker": ticker,
            "error": str(e),
            "patterns": None,
        }


@router.get("/confluence/{ticker}/refresh")
async def manual_refresh(ticker: str, timeframe: str = Query("all")):
    """
    Manually force refresh of confluence levels for a ticker.
    
    Args:
        ticker: stock symbol
        timeframe: 'daily', 'weekly', 'monthly', or 'all'
    
    Only use this for debugging; levels refresh on schedule automatically.
    """
    ticker = ticker.upper()

    try:
        if timeframe == "all":
            timeframes = ["daily", "weekly", "monthly"]
        else:
            timeframes = [timeframe]

        results = {}
        for tf in timeframes:
            # Clear cache to force refresh
            key = (ticker, tf)
            if key in _analyzer.cache:
                del _analyzer.cache[key]
            
            # Refresh
            levels = _analyzer.get_or_refresh_levels(ticker, tf)
            results[tf] = levels

        return {
            "ticker": ticker,
            "refreshed": timeframes,
            "levels": results,
        }
    except Exception as e:
        logger.error(f"Error refreshing confluence levels for {ticker}: {e}")
        return {
            "ticker": ticker,
            "error": str(e),
        }

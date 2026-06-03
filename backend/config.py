"""
Central configuration for the picker backend.
"""
import os
from pathlib import Path
from zoneinfo import ZoneInfo

# Load .env file from project root (if present)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass  # python-dotenv not installed — rely on real env vars

# ---------------------------------------------------------------------------
# Tickers
# ---------------------------------------------------------------------------
TICKERS = ["SPY", "QQQ", "SPX", "AAPL", "GOOGL", "NVDA", "TSLA", "AMZN", "MSFT", "PLTR", "META", "AMD"]

# ---------------------------------------------------------------------------
# Market session hours (US Eastern)
# ---------------------------------------------------------------------------
ET = ZoneInfo("America/New_York")

SESSION_HOURS = {
    "pre":   ("04:00", "09:30"),
    "regular": ("09:30", "16:00"),
    "after": ("16:00", "20:00"),
}


def classify_session(dt_et) -> str:
    """Return 'pre', 'regular', 'after', or 'closed' for a datetime in ET."""
    t = dt_et.strftime("%H:%M")
    for session, (start, end) in SESSION_HOURS.items():
        if start <= t < end:
            return session
    return "closed"


def is_regular_hours() -> bool:
    """Return True only during NYSE regular session (09:30–16:00 ET, Mon–Fri)."""
    from datetime import datetime, timezone
    now_et = datetime.now(timezone.utc).astimezone(ET)
    if now_et.weekday() >= 5:   # Saturday=5, Sunday=6
        return False
    return classify_session(now_et) == "regular"


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
DB_PATH: str = os.environ.get("DB_PATH", str(BASE_DIR / "picker.db"))

# ---------------------------------------------------------------------------
# Scheduler — Multi-timeframe fetch schedule
# ---------------------------------------------------------------------------
# Each timeframe has its own fetch loop, clock-aligned to its bar-close
# boundary plus a small buffer (so yfinance has time to publish the bar).
# stagger_offset_seconds keeps the three loops from colliding at top-of-hour
# boundaries where all three would otherwise fire simultaneously.
#
#   tf  | interval_seconds | bar-close clock         | stagger offset
#   2m  |  120             | every even minute       | +15s  → :MM:15
#   5m  |  300             | :00 :05 :10 ... :55     | +30s  → :MM:30
#   15m |  900             | :00 :15 :30 :45         | +45s  → :MM:45
#   Indicator bar-count tunables per TF (preserve 2m calibration, sensible HTF values):
#     swing_pivot_bars     \u2014 N bars each side for swing-high/low confirmation
#     candle_window_bars   \u2014 lookback for pattern detection (last \u2248patterns window)
#     candle_struct_bars   \u2014 lookback for structure/HH-HL analysis
#     bar_minutes          \u2014 nominal minutes per bar (drives sqrt-time threshold scaling)
TIMEFRAMES: dict[str, dict] = {
    "2m":  {"interval_seconds": 120, "stagger_offset_seconds": 15, "yf_period": "5d",  "yf_interval": "2m",
            "bar_minutes":  2, "swing_pivot_bars": 3, "candle_window_bars": 6, "candle_struct_bars": 12,
            "prediction_horizon_minutes": 10},
    "5m":  {"interval_seconds": 300, "stagger_offset_seconds": 30, "yf_period": "5d",  "yf_interval": "5m",
            "bar_minutes":  5, "swing_pivot_bars": 2, "candle_window_bars": 6, "candle_struct_bars": 12,
            "prediction_horizon_minutes": 30},
    # 15m loop disabled (perf): keeping the dict entry commented out so the
    # scheduler does not spawn a third fetch/compute task. Re-enable by
    # un-commenting if/when backend has headroom.
    # "15m": {"interval_seconds": 900, "stagger_offset_seconds": 45, "yf_period": "10d", "yf_interval": "15m",
    #         "bar_minutes": 15, "swing_pivot_bars": 2, "candle_window_bars": 4, "candle_struct_bars":  6,
    #         "prediction_horizon_minutes": 60},
}

# Primary timeframe — the one that drives the full indicator/signal/AI pipeline
# in Phase 1. Higher TFs only persist candles until Phase 2 lights up per-TF
# indicator computation.
PRIMARY_TIMEFRAME: str = "2m"

# Legacy — kept for any external callers / tests still importing it.
FETCH_INTERVAL_SECONDS: int = int(os.environ.get("FETCH_INTERVAL", "120"))
OHLCV_FETCH_LIMIT: int = 400  # bars per fetch — today (~190) + prev regular (~78)
ALERT_DEDUP_SECS: int = 300  # suppress same alert within 5 min

# ---------------------------------------------------------------------------
# AI evaluator
# ---------------------------------------------------------------------------
ML_MIN_SAMPLES: int = 500          # fall back to rule-only below this
ABSTAIN_CONFIDENCE_THRESHOLD: float = 0.40  # predictions below this become ABSTAIN
PREDICTION_HORIZON_BARS: int = 3   # evaluate outcome after N 5-min bars

# ---------------------------------------------------------------------------
# Web Push (VAPID)
# ---------------------------------------------------------------------------
VAPID_PRIVATE_KEY: str = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY: str = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_CONTACT_EMAIL: str = os.environ.get("VAPID_CONTACT_EMAIL", "admin@nysepicker.duckdns.org")

# ---------------------------------------------------------------------------
# LLM Commentary  (optional — set LLM_PROVIDER="disabled" to turn off)
# ---------------------------------------------------------------------------
# Providers: "gemini" | "openai" | "anthropic" | "ollama" | "disabled"
# API keys are read from environment variables — never hard-code them here.
LLM_PROVIDER: str = os.environ.get("LLM_PROVIDER", "disabled")
LLM_API_KEY: str  = os.environ.get("LLM_API_KEY", "")
# Model overrides (sensible free-tier defaults per provider)
LLM_MODEL: str = os.environ.get("LLM_MODEL", "")  # blank = provider default
# Per-provider defaults used when LLM_MODEL is blank:
LLM_MODEL_DEFAULTS: dict = {
    "gemini":    "gemini-2.0-flash-lite",  # free tier: 30 RPM / 1500 RPD
    "openai":    "gpt-4o-mini",            # cheapest OpenAI model
    "anthropic": "claude-haiku-4-5",       # cheapest Anthropic model
    "ollama":    "llama3.1",               # local, no key needed
}
OLLAMA_BASE_URL: str = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

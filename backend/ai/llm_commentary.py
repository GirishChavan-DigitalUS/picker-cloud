"""
LLM Commentary — generates a plain-English trade rationale for each prediction.

Supported providers (set LLM_PROVIDER in config.py or env var):
  "gemini"    — Google Gemini 2.0 Flash Lite (free tier: 30 RPM, no credit card)
  "openai"    — OpenAI GPT-4o-mini  (pay-as-you-go, ~$0.001 per call)
  "anthropic" — Claude Haiku        (pay-as-you-go, ~$0.001 per call)
  "ollama"    — Local Llama/Mistral  (100% free, requires Ollama running locally)
  "disabled"  — No LLM, returns None immediately

API keys are read from environment variables (LLM_API_KEY).
Never commit keys to source control.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ai.schemas import PredictionOutput

logger = logging.getLogger(__name__)

# ── Change tracker — only call LLM when prediction meaningfully changes ──────
# Stores last (prediction, confidence) per ticker to avoid redundant calls.
_last_prediction: dict[str, tuple[str, float]] = {}


def _prediction_changed(ticker: str, prediction: str, confidence: float) -> bool:
    """Return True if direction changed OR confidence shifted by ≥10 points."""
    prev = _last_prediction.get(ticker)
    if prev is None:
        return True
    prev_pred, prev_conf = prev
    if prediction != prev_pred:
        return True
    if abs(confidence - prev_conf) >= 0.10:
        return True
    return False


def _record_prediction(ticker: str, prediction: str, confidence: float) -> None:
    _last_prediction[ticker] = (prediction, confidence)
# Gemini free tier: 15 RPM for gemini-2.0-flash-lite.
# With N tickers serialised through this lock, MIN_INTERVAL keeps us under 15 RPM.
_rate_lock = asyncio.Lock()
_last_call_ts: float = 0.0
MIN_INTERVAL: float = 4.5   # seconds between LLM calls
# 429 back-off: when any LLM call is throttled, block ALL calls for this window.
# Shared by tape_read (which imports _rate_limited_call) and commentary.
_global_backoff_until: float = 0.0


async def _rate_limited_call(coro):
    """Serialize LLM calls with MIN_INTERVAL spacing.

    On a 429 response sets a module-level back-off so ALL subsequent calls
    (from both llm_commentary and tape_read) are skipped for 90 seconds.
    The awaiting coroutine is closed cleanly before raising.
    """
    global _last_call_ts, _global_backoff_until
    async with _rate_lock:
        # Drop the call immediately if we're in a 429 back-off window
        if time.monotonic() < _global_backoff_until:
            coro.close()   # prevent coroutine-was-never-awaited warning
            raise RuntimeError(
                f"LLM back-off active for "
                f"{int(_global_backoff_until - time.monotonic())}s more"
            )
        now = time.monotonic()
        gap = now - _last_call_ts
        if gap < MIN_INTERVAL:
            await asyncio.sleep(MIN_INTERVAL - gap)
        _last_call_ts = time.monotonic()
    try:
        return await coro
    except Exception as exc:
        if "429" in str(exc) or "Too Many Requests" in str(exc):
            _global_backoff_until = time.monotonic() + 90.0
            logger.warning(
                "429 from LLM — all LLM calls paused 90s: %s", exc
            )
        raise

# ── Prompt builder ────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = (
    "You are a concise intraday trading assistant. "
    "Given technical indicator signals for a stock, write exactly 2 sentences: "
    "one explaining the current setup and one actionable takeaway. "
    "Be specific. Use numbers where available. No disclaimers. No markdown."
)

def _build_user_prompt(ticker: str, prediction: "PredictionOutput") -> str:
    ev = prediction.evidence
    rules = prediction.rules_triggered
    direction = prediction.prediction
    confidence = round(prediction.confidence * 100)

    lines = [
        f"Ticker: {ticker}",
        f"AI prediction: {direction} with {confidence}% confidence",
        f"Rules fired: {', '.join(rules) if rules else 'none'}",
        f"EMA state: {ev.ema_state}",
        f"Price vs VWAP: {ev.price_vs_vwap} (motion: {ev.vwap_motion})",
        f"Daily trend: {ev.daily_trend}",
        f"Current price: {ev.price}",
    ]
    if ev.nearest_support:
        lines.append(f"Nearest support: {ev.nearest_support:.2f}")
    if ev.nearest_resistance:
        lines.append(f"Nearest resistance: {ev.nearest_resistance:.2f}")
    if ev.recent_return_5m is not None:
        lines.append(f"Last 5-min return: {ev.recent_return_5m * 100:.3f}%")
    if ev.volume_ratio is not None:
        lines.append(f"Volume vs avg: {ev.volume_ratio:.2f}×")
    return "\n".join(lines)


# ── Provider implementations ──────────────────────────────────────────────────

async def _call_gemini(model: str, api_key: str, user_msg: str) -> str:
    import httpx
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    payload = {
        "system_instruction": {"parts": [{"text": _SYSTEM_PROMPT}]},
        "contents": [{"parts": [{"text": user_msg}]}],
        "generationConfig": {"maxOutputTokens": 120, "temperature": 0.3},
    }
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(url, json=payload)
        r.raise_for_status()
        return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()


async def _call_openai(model: str, api_key: str, user_msg: str) -> str:
    import httpx
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user",   "content": user_msg},
        ],
        "max_tokens": 120,
        "temperature": 0.3,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json=payload,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()


async def _call_anthropic(model: str, api_key: str, user_msg: str) -> str:
    import httpx
    payload = {
        "model": model,
        "max_tokens": 120,
        "system": _SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_msg}],
    }
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            },
            json=payload,
        )
        r.raise_for_status()
        return r.json()["content"][0]["text"].strip()


async def _call_ollama(model: str, base_url: str, user_msg: str) -> str:
    import httpx
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user",   "content": user_msg},
        ],
        "stream": False,
        "options": {"num_predict": 120, "temperature": 0.3},
    }
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(f"{base_url}/api/chat", json=payload)
        r.raise_for_status()
        return r.json()["message"]["content"].strip()


# ── Public entry point ────────────────────────────────────────────────────────

async def generate_commentary(ticker: str, prediction: "PredictionOutput") -> str | None:
    """
    Generate a 2-sentence plain-English trade rationale.
    Returns None if LLM_PROVIDER is "disabled" or if the call fails.
    Result is stored in prediction.notes and broadcast via WebSocket.
    """
    from config import (
        LLM_PROVIDER, LLM_API_KEY, LLM_MODEL,
        LLM_MODEL_DEFAULTS, OLLAMA_BASE_URL,
    )

    provider = LLM_PROVIDER.lower().strip()
    if provider == "disabled" or not provider:
        return None

    # Skip if prediction hasn't meaningfully changed — saves quota
    if not _prediction_changed(ticker, prediction.prediction, prediction.confidence):
        return None

    model = LLM_MODEL or LLM_MODEL_DEFAULTS.get(provider, "")
    user_msg = _build_user_prompt(ticker, prediction)

    try:
        if provider == "gemini":
            result = await _rate_limited_call(_call_gemini(model, LLM_API_KEY, user_msg))
        elif provider == "openai":
            result = await _rate_limited_call(_call_openai(model, LLM_API_KEY, user_msg))
        elif provider == "anthropic":
            result = await _rate_limited_call(_call_anthropic(model, LLM_API_KEY, user_msg))
        elif provider == "ollama":
            result = await _rate_limited_call(_call_ollama(model, OLLAMA_BASE_URL, user_msg))
        else:
            logger.warning("llm_commentary: unknown provider %r — skipping", provider)
            return None
        _record_prediction(ticker, prediction.prediction, prediction.confidence)
        return result
    except Exception as exc:
        logger.warning("llm_commentary [%s] %s error: %s", ticker, provider, exc)
        return None

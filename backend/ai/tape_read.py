"""
Tape Read — LLM-powered Senior Trader narrative (v4).

Receives the fully-enriched indicator snapshot (including candle_context
fields) and generates a 3-line trader read:

  LINE 1  Tape environment (≤5 words)
  LINE 2  Dominant setup or risk (≤2 sentences, specific levels)
  LINE 3  Next probable move + confirm/invalidate level (≤2 sentences)

Provider reuse
--------------
Uses the same provider config as llm_commentary.py.
Shares the same rate-limiter (_rate_limited_call) so the combined
LLM call budget across both modules stays within provider limits.

Change detection
----------------
Only calls the LLM when the tape-read-relevant slice of the snapshot
has changed meaningfully since the last call.  The cached narrative is
returned otherwise (no LLM cost, no latency).
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Fields that define "the tape context has changed"
# ---------------------------------------------------------------------------
_CONTEXT_KEYS = (
    "candle_structure", "candle_patterns", "candle_body_trend",
    "candle_vol_char",  "candle_near_level", "candle_pace",
    "candle_close_pos", "price_vs_vwap",    "ema_state",
    "daily_trend",      "rvol",              "bull_score",
    "bear_score",       "candle_hh_hl",      "candle_lh_ll",
)

# In-process cache: ticker → (context_hash, narrative)
_cache: dict[str, tuple[str, str]] = {}


def _ctx_hash(snapshot: dict) -> str:
    slim = {k: snapshot.get(k) for k in _CONTEXT_KEYS}
    return hashlib.md5(
        json.dumps(slim, sort_keys=True, default=str).encode()
    ).hexdigest()


def _changed(ticker: str, snapshot: dict) -> bool:
    h = _ctx_hash(snapshot)
    cached = _cache.get(ticker)
    return cached is None or cached[0] != h


def _put_cache(ticker: str, snapshot: dict, narrative: str) -> None:
    _cache[ticker] = (_ctx_hash(snapshot), narrative)


def _get_cache(ticker: str) -> str | None:
    entry = _cache.get(ticker)
    return entry[1] if entry else None


# ---------------------------------------------------------------------------
# System prompt — Senior Trader persona (v5: synthesises tape + AI eval)
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT = (
    "You are a senior prop-desk trader with 15+ years reading intraday tape. "
    "You receive BOTH short-term candle data (last 30 min) AND broader structural "
    "indicator signals for a stock. Your job is to synthesise these into a unified "
    "3-line market read that explicitly reconciles any divergence between the "
    "short-term tape and the broader trend.\n\n"
    "Format your response as EXACTLY 3 lines (no headers, no markdown, no disclaimers):\n"
    "LINE 1 (\u22655 words): Overall setup label "
    "(examples: 'Bull Flag Pullback', 'Trending With Conviction', 'Fade at Resistance', "
    "'Coiling Below VWAP')\n"
    "LINE 2 (\u22642 sentences): What the structural indicators say vs what the tape says right now. "
    "If they agree, state why the confluence is meaningful. "
    "If they diverge, explain the conflict. Name specific levels.\n"
    "LINE 3 (\u22642 sentences): The next probable move and the level that confirms or "
    "invalidates it."
)


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------
def _fmt(v: Any) -> str:
    if v is None:
        return "—"
    if isinstance(v, float):
        return f"{v:.2f}"
    if isinstance(v, list):
        return ", ".join(str(x) for x in v) if v else "none"
    return str(v)


def _build_prompt(ticker: str, snapshot: dict, price: float) -> str:
    patterns = snapshot.get("candle_patterns") or []
    near_lvl = snapshot.get("candle_near_level") or "none"
    lines = [
        f"Ticker: {ticker}  |  Price: {price:.2f}",
        f"Structure (60-min): {_fmt(snapshot.get('candle_structure'))}"
        f"  |  HH/HL: {snapshot.get('candle_hh_hl')}"
        f"  |  LH/LL: {snapshot.get('candle_lh_ll')}",
        f"Body trend: {_fmt(snapshot.get('candle_body_trend'))}"
        f"  |  Pace: {_fmt(snapshot.get('candle_pace'))}"
        f"  |  Close pos: {_fmt(snapshot.get('candle_close_pos'))}",
        f"Patterns (last 30 min): {_fmt(patterns)}  |  Context: near {near_lvl}",
        f"Volume char: {_fmt(snapshot.get('candle_vol_char'))}"
        f"  |  RVOL: {_fmt(snapshot.get('rvol'))}×",
        f"VWAP: {_fmt(snapshot.get('vwap'))}"
        f"  |  Pos: {_fmt(snapshot.get('price_vs_vwap'))}"
        f"  |  Motion: {_fmt(snapshot.get('vwap_motion'))}",
        f"EMA state: {_fmt(snapshot.get('ema_state'))}"
        f"  |  Daily trend: {_fmt(snapshot.get('daily_trend'))}",
        f"ORB H/L: {_fmt(snapshot.get('orb_high'))} / {_fmt(snapshot.get('orb_low'))}"
        f"  |  HOD: {_fmt(snapshot.get('hod'))}"
        f"  |  LOD: {_fmt(snapshot.get('lod'))}",
        f"Supp: {_fmt(snapshot.get('nearest_support'))}"
        f"  |  Res: {_fmt(snapshot.get('nearest_resistance'))}",
        f"PDH: {_fmt(snapshot.get('prev_day_high'))}"
        f"  |  PDL: {_fmt(snapshot.get('prev_day_low'))}"
        f"  |  Prev close: {_fmt(snapshot.get('prev_day_close'))}",
        f"AI Evaluation: {_fmt(snapshot.get('ai_prediction'))} direction"
        f"  |  Confidence: {_fmt(snapshot.get('ai_confidence'))}",
        f"RSI-14: {_fmt(snapshot.get('rsi_14'))}"
        f"  |  Bull score: {_fmt(snapshot.get('bull_score'))}/9"
        f"  |  Bear score: {_fmt(snapshot.get('bear_score'))}/9"
        f"  |  Bias: {_fmt(snapshot.get('confluence_bias'))}",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Generic LLM caller (all providers, accepts any system prompt)
# ---------------------------------------------------------------------------
async def _call_llm(
    provider: str,
    model: str,
    api_key: str,
    base_url: str,
    user_msg: str,
) -> str:
    import httpx

    if provider == "gemini":
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model}:generateContent?key={api_key}"
        )
        payload = {
            "system_instruction": {"parts": [{"text": _SYSTEM_PROMPT}]},
            "contents":           [{"parts": [{"text": user_msg}]}],
            "generationConfig":   {"maxOutputTokens": 160, "temperature": 0.3},
        }
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(url, json=payload)
            r.raise_for_status()
            return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()

    if provider == "openai":
        payload = {
            "model":       model,
            "messages":    [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user",   "content": user_msg},
            ],
            "max_tokens":  160,
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

    if provider == "anthropic":
        payload = {
            "model":      model,
            "max_tokens": 160,
            "system":     _SYSTEM_PROMPT,
            "messages":   [{"role": "user", "content": user_msg}],
        }
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key":          api_key,
                    "anthropic-version":  "2023-06-01",
                },
                json=payload,
            )
            r.raise_for_status()
            return r.json()["content"][0]["text"].strip()

    if provider == "ollama":
        payload = {
            "model":    model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user",   "content": user_msg},
            ],
            "stream":   False,
            "options":  {"num_predict": 160, "temperature": 0.3},
        }
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{base_url}/api/chat", json=payload)
            r.raise_for_status()
            return r.json()["message"]["content"].strip()

    raise ValueError(f"Unknown LLM provider: {provider!r}")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
async def generate_tape_read(
    ticker: str,
    snapshot: dict,
    current_price: float,
    force: bool = False,
) -> str | None:
    """
    Generate the 3-line Senior Trader tape read narrative.

    Returns the cached narrative when the tape context has not changed
    (unless force=True, which bypasses the change-detection cache).
    Returns None when LLM_PROVIDER is "disabled" or the call fails
    (in which case the caller should keep any previously stored value).
    """
    from config import (
        LLM_PROVIDER, LLM_API_KEY, LLM_MODEL,
        LLM_MODEL_DEFAULTS, OLLAMA_BASE_URL,
    )
    # Import shared rate-limiter from llm_commentary so all LLM calls
    # (prediction commentary + tape read) share the same quota window.
    from ai.llm_commentary import _rate_limited_call

    provider = LLM_PROVIDER.lower().strip()
    if not provider or provider == "disabled":
        return None

    if not force and not _changed(ticker, snapshot):
        return _get_cache(ticker)   # context unchanged — no LLM call

    model    = LLM_MODEL or LLM_MODEL_DEFAULTS.get(provider, "")
    user_msg = _build_prompt(ticker, snapshot, current_price)

    try:
        result = await _rate_limited_call(
            _call_llm(provider, model, LLM_API_KEY, OLLAMA_BASE_URL, user_msg)
        )
        _put_cache(ticker, snapshot, result)
        logger.info("[%s] Tape read: %s…", ticker, result[:60])
        return result
    except Exception as exc:
        logger.warning("[%s] Tape read LLM error: %s", ticker, exc)
        return _get_cache(ticker)   # return stale cache rather than None

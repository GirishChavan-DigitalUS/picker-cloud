"""
Database initialisation and async helper utilities (aiosqlite).

Performance: hot-path writes (scheduler) use a shared persistent connection
(_write_conn) guarded by an asyncio lock, avoiding the overhead of opening
and closing a connection on every INSERT/UPDATE.  Read-only route handlers
still use get_db() which returns a fresh connection.
"""
import asyncio

import aiosqlite
from config import DB_PATH

# ---------------------------------------------------------------------------
# Shared write connection — eliminates per-call connect/close overhead for the
# scheduler hot path (~5-10 ms saved per DB operation × dozens per cycle).
# ---------------------------------------------------------------------------
_write_conn: aiosqlite.Connection | None = None
_write_lock = asyncio.Lock()


async def _get_write_conn() -> aiosqlite.Connection:
    """Return the shared write connection, creating it on first call."""
    global _write_conn
    if _write_conn is None:
        _write_conn = await aiosqlite.connect(DB_PATH)
        await _write_conn.execute("PRAGMA journal_mode=WAL")
        await _write_conn.execute("PRAGMA synchronous=NORMAL")
        _write_conn.row_factory = aiosqlite.Row
    return _write_conn


async def close_pool() -> None:
    """Close the shared write connection (called on shutdown)."""
    global _write_conn
    if _write_conn:
        await _write_conn.close()
        _write_conn = None


CREATE_TABLES_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS candles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker      TEXT    NOT NULL,
    timestamp   TEXT    NOT NULL,   -- ISO-8601 UTC
    timeframe   TEXT    NOT NULL DEFAULT '2m',
    session     TEXT    NOT NULL DEFAULT 'regular',
    open        REAL    NOT NULL,
    high        REAL    NOT NULL,
    low         REAL    NOT NULL,
    close       REAL    NOT NULL,
    volume      REAL    NOT NULL DEFAULT 0,
    UNIQUE(ticker, timestamp, timeframe)
);

CREATE TABLE IF NOT EXISTS indicators (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker              TEXT    NOT NULL,
    timestamp           TEXT    NOT NULL,
    ema9                REAL,
    ema21               REAL,
    ema50               REAL,
    ema_state           TEXT,   -- BULLISH | BEARISH
    ema_cross_ts        TEXT,   -- ISO-8601 of last crossover
    vwap                REAL,
    vwap_distance_pct   REAL,
    vwap_motion         TEXT,   -- TOWARD | AWAY | FLAT
    vwap_slope          REAL,
    price_vs_vwap       TEXT,   -- ABOVE | BELOW
    daily_trend         TEXT,   -- BULL | BEAR | NEUTRAL
    poc                 REAL,
    nearest_support     REAL,
    nearest_resistance  REAL,
    swing_high          REAL,
    swing_high_ts       TEXT,
    swing_low           REAL,
    swing_low_ts        TEXT,
    recent_return_5m    REAL,
    recent_volatility   REAL,
    -- Session levels (added v2)
    pm_high             REAL,   -- premarket high
    pm_low              REAL,   -- premarket low
    orb_high            REAL,   -- 15-min ORB high
    orb_low             REAL,   -- 15-min ORB low
    prev_day_high       REAL,   -- previous regular session high
    prev_day_low        REAL,   -- previous regular session low
    poc_pre             REAL,   -- premarket session POC
    poc_regular         REAL,   -- regular session POC
    poc_after           REAL,   -- after-hours session POC
    -- Momentum / RSI (added v3)
    rsi_14              REAL,   -- RSI-14 (Wilder smoothing)
    rsi_state           TEXT,   -- OVERBOUGHT | OVERSOLD | NEUTRAL
    -- Volume confirmation (added v3)
    rvol                REAL,   -- current bar volume / 20-bar avg
    volume_state        TEXT,   -- HIGH | LOW | NORMAL
    -- EMA spread (added v3)
    ema_spread_pct      REAL,   -- (ema9 - ema21) / ema21 * 100
    -- Confluence scoring (added v3)
    bull_score          INTEGER,
    bear_score          INTEGER,
    confluence_bias     TEXT,   -- BULL | BEAR | MIXED
    -- Candle context (added v4)
    hod                 REAL,   -- today's intraday high
    lod                 REAL,   -- today's intraday low
    prev_day_close      REAL,   -- previous regular session close
    atr_14              REAL,   -- 14-bar Average True Range
    candle_structure    TEXT,   -- UPTREND | DOWNTREND | COILING | CHOPPY
    candle_hh_hl        INTEGER,-- 1 = higher-highs / higher-lows confirmed
    candle_lh_ll        INTEGER,-- 1 = lower-highs / lower-lows confirmed
    candle_body_trend   TEXT,   -- EXPANDING | CONTRACTING | STEADY
    candle_pace         TEXT,   -- TRENDING | CHOPPY
    candle_vol_char     TEXT,   -- INSTITUTIONAL | CLIMAX | THIN | NORMAL
    candle_close_pos    TEXT,   -- UPPER | MIDDLE | LOWER
    candle_near_level   TEXT,   -- nearest key level within 0.3%
    candle_patterns     TEXT,   -- JSON array of detected pattern names
    tape_read_narrative TEXT,   -- LLM senior trader narrative (3 lines)
    UNIQUE(ticker, timestamp)
);

CREATE TABLE IF NOT EXISTS signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker      TEXT    NOT NULL,
    timestamp   TEXT    NOT NULL,
    signal_type TEXT    NOT NULL,   -- ema_cross | vwap_reclaim | vwap_breakdown | sr_break | new_swing
    direction   TEXT    NOT NULL,   -- UP | DOWN
    details     TEXT                -- JSON blob
);

CREATE TABLE IF NOT EXISTS predictions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker              TEXT    NOT NULL,
    timestamp           TEXT    NOT NULL,
    prediction          TEXT    NOT NULL,   -- UP | DOWN | NEUTRAL | ABSTAIN
    confidence          REAL    NOT NULL,
    evidence            TEXT    NOT NULL,   -- JSON blob
    rules_triggered     TEXT    NOT NULL,   -- JSON array
    notes               TEXT,
    outcome             TEXT,               -- UP | DOWN | FLAT (filled in later)
    outcome_timestamp   TEXT
);

CREATE INDEX IF NOT EXISTS idx_candles_ticker_ts ON candles(ticker, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_candles_ticker_tf_ts ON candles(ticker, timeframe, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_indicators_ticker_ts ON indicators(ticker, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_indicators_ticker_tf_ts ON indicators(ticker, timeframe, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_signals_ticker_ts ON signals(ticker, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_ticker_ts ON predictions(ticker, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_ticker_tf_ts ON predictions(ticker, timeframe, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_predictions_outcome ON predictions(outcome) WHERE outcome IS NULL;

CREATE TABLE IF NOT EXISTS composite_alerts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker          TEXT    NOT NULL,
    timestamp       TEXT    NOT NULL,
    signal          TEXT    NOT NULL,   -- POWER_TREND_BULL | STRUCTURE_BREAK_UP | ...
    direction       TEXT    NOT NULL,   -- UP | DOWN | WARNING
    tier            INTEGER NOT NULL,   -- 1 | 2 | 3
    ai_confidence   REAL    NOT NULL,
    components      TEXT    NOT NULL,   -- JSON array
    suppressed_by   TEXT,               -- null or reason string
    timeframe       TEXT    NOT NULL DEFAULT '2m',
    extra           TEXT,               -- JSON blob for level_price, level_name, etc.
    cycle_ts        TEXT                -- ISO-8601 timestamp of the scheduler cycle that generated this alert
);

CREATE INDEX IF NOT EXISTS idx_composite_alerts_ticker_ts ON composite_alerts(ticker, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_composite_alerts_dedup ON composite_alerts(ticker, signal, timeframe, timestamp DESC);

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT    PRIMARY KEY,
    username    TEXT    NOT NULL,
    ip_address  TEXT    NOT NULL DEFAULT 'unknown',
    user_agent  TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL,
    last_seen   TEXT    NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS login_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL,
    ip_address  TEXT    NOT NULL DEFAULT 'unknown',
    user_agent  TEXT    NOT NULL DEFAULT '',
    success     INTEGER NOT NULL DEFAULT 0,
    ts          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username, is_active);
CREATE INDEX IF NOT EXISTS idx_login_log_ts ON login_log(ts DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint    TEXT    NOT NULL UNIQUE,
    p256dh      TEXT    NOT NULL,
    auth        TEXT    NOT NULL,
    tickers     TEXT,               -- JSON array of subscribed tickers, NULL = all
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS confluence_levels (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker          TEXT    NOT NULL,
    timeframe       TEXT    NOT NULL,   -- 'daily' | 'weekly' | 'monthly'
    poc             REAL,
    val             REAL,
    vah             REAL,
    pivot           REAL,
    s1              REAL,
    s2              REAL,
    r1              REAL,
    r2              REAL,
    last_updated    TEXT    NOT NULL,   -- ISO-8601 UTC
    UNIQUE(ticker, timeframe)
);

CREATE INDEX IF NOT EXISTS idx_confluence_ticker ON confluence_levels(ticker);
"""


async def init_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(CREATE_TABLES_SQL)
        # Migration: add v2 session-level columns if they don't exist yet
        _new_cols = [
            "pm_high", "pm_low", "orb_high", "orb_low",
            "prev_day_high", "prev_day_low",
            "poc_pre", "poc_regular", "poc_after",
            "ema50",
            # v3
            ("rsi_14",         "REAL"),
            ("rsi_state",      "TEXT"),
            ("rvol",           "REAL"),
            ("volume_state",   "TEXT"),
            ("ema_spread_pct", "REAL"),
            ("bull_score",     "INTEGER"),
            ("bear_score",     "INTEGER"),
            ("confluence_bias","TEXT"),
            # v4 candle context
            ("hod",               "REAL"),
            ("lod",               "REAL"),
            ("prev_day_close",    "REAL"),
            ("atr_14",            "REAL"),
            ("candle_structure",  "TEXT"),
            ("candle_hh_hl",      "INTEGER"),
            ("candle_lh_ll",      "INTEGER"),
            ("candle_body_trend", "TEXT"),
            ("candle_pace",       "TEXT"),
            ("candle_vol_char",   "TEXT"),
            ("candle_close_pos",  "TEXT"),
            ("candle_near_level", "TEXT"),
            ("candle_patterns",   "TEXT"),
            ("tape_read_narrative","TEXT"),
        ]
        for col in _new_cols:
            if isinstance(col, tuple):
                name, ctype = col
                stmt = f"ALTER TABLE indicators ADD COLUMN {name} {ctype}"
            else:
                stmt = f"ALTER TABLE indicators ADD COLUMN {col} REAL"
            try:
                await db.execute(stmt)
            except Exception:
                pass  # column already exists
        # Add timeframe column to indicators if missing
        for stmt in [
            "ALTER TABLE indicators ADD COLUMN timeframe TEXT DEFAULT '2m'",
            "ALTER TABLE composite_alerts ADD COLUMN timeframe TEXT DEFAULT '2m'",
            "ALTER TABLE composite_alerts ADD COLUMN cycle_ts TEXT",
            "ALTER TABLE predictions ADD COLUMN timeframe TEXT DEFAULT '2m'",
        ]:
            try:
                await db.execute(stmt)
            except Exception:
                pass
        await db.commit()


async def get_db() -> aiosqlite.Connection:
    """Return a new connection. Caller is responsible for closing it."""
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


async def upsert_candles(ticker: str, bars: list[dict]) -> None:
    """Insert-or-replace a list of OHLCV bar dicts for a ticker."""
    conn = await _get_write_conn()
    async with _write_lock:
        await conn.executemany(
            """
            INSERT INTO candles (ticker, timestamp, timeframe, session, open, high, low, close, volume)
            VALUES (:ticker, :timestamp, :timeframe, :session, :open, :high, :low, :close, :volume)
            ON CONFLICT(ticker, timestamp, timeframe) DO UPDATE SET
                open    = excluded.open,
                high    = excluded.high,
                low     = excluded.low,
                close   = excluded.close,
                volume  = excluded.volume,
                session = excluded.session
            """,
            [{"ticker": ticker, **bar} for bar in bars],
        )
        await conn.commit()


async def upsert_indicator_snapshot(ticker: str, snapshot: dict, timeframe: str = "2m") -> None:
    """Insert-or-replace a full indicator snapshot for a ticker + timestamp + timeframe."""
    snap = {**snapshot, "timeframe": timeframe}
    fields = list(snap.keys())
    placeholders = ", ".join(["?"] * (len(fields) + 1))
    vals = [ticker] + [snap[f] for f in fields]
    sql = (
        f"INSERT INTO indicators (ticker, {', '.join(fields)}) "
        f"VALUES ({placeholders}) "
        f"ON CONFLICT(ticker, timestamp) DO UPDATE SET "
        + ", ".join(f"{f} = excluded.{f}" for f in fields if f != "timestamp")
    )
    conn = await _get_write_conn()
    async with _write_lock:
        await conn.execute(sql, vals)
        await conn.commit()


async def insert_signal(ticker: str, signal: dict) -> None:
    conn = await _get_write_conn()
    async with _write_lock:
        await conn.execute(
            "INSERT INTO signals (ticker, timestamp, signal_type, direction, details) "
            "VALUES (:ticker, :timestamp, :signal_type, :direction, :details)",
            {"ticker": ticker, **signal},
        )
        await conn.commit()


async def insert_prediction(prediction: dict) -> int:
    conn = await _get_write_conn()
    async with _write_lock:
        cur = await conn.execute(
            "INSERT INTO predictions (ticker, timestamp, prediction, confidence, evidence, rules_triggered, notes, timeframe) "
            "VALUES (:ticker, :timestamp, :prediction, :confidence, :evidence, :rules_triggered, :notes, :timeframe)",
            prediction,
        )
        await conn.commit()
        return cur.lastrowid


async def get_all_latest_predictions() -> list[dict]:
    """Return the most recent prediction row for each ticker (used to seed commentary cache)."""
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        rows = await conn.execute_fetchall(
            "SELECT ticker, confidence FROM predictions "
            "WHERE id IN (SELECT MAX(id) FROM predictions GROUP BY ticker)",
        )
    return [dict(r) for r in rows]


async def update_prediction_outcome(prediction_id: int, outcome: str, outcome_ts: str) -> None:
    conn = await _get_write_conn()
    async with _write_lock:
        await conn.execute(
            "UPDATE predictions SET outcome = ?, outcome_timestamp = ? WHERE id = ?",
            (outcome, outcome_ts, prediction_id),
        )
        await conn.commit()


async def composite_alert_exists(
    ticker: str, signal: str, timeframe: str, within_seconds: int
) -> bool:
    """Return True if the same (ticker, signal, timeframe) alert was inserted recently."""
    from datetime import datetime, timezone, timedelta
    since = (datetime.now(timezone.utc) - timedelta(seconds=within_seconds)).isoformat()
    conn = await _get_write_conn()
    async with _write_lock:
        rows = await conn.execute_fetchall(
            "SELECT id FROM composite_alerts "
            "WHERE ticker=? AND signal=? AND timeframe=? AND timestamp >= ? LIMIT 1",
            (ticker, signal, timeframe, since),
        )
    return len(rows) > 0


async def insert_composite_alert(alert: dict) -> None:
    import json as _json
    extra_keys = {"level_name", "level_price", "poc_level"}
    extra = {k: alert[k] for k in extra_keys if k in alert}
    conn = await _get_write_conn()
    async with _write_lock:
        await conn.execute(
            "INSERT INTO composite_alerts "
            "(ticker, timestamp, signal, direction, tier, ai_confidence, components, suppressed_by, timeframe, extra, cycle_ts) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                alert["ticker"],
                alert["timestamp"],
                alert["signal"],
                alert["direction"],
                alert["tier"],
                alert["ai_confidence"],
                _json.dumps(alert.get("components", [])),
                alert.get("suppressed_by"),
                alert.get("timeframe", "5m"),
                _json.dumps(extra) if extra else None,
                alert.get("cycle_ts"),
            ),
        )
        await conn.commit()


async def get_composite_alerts(
    ticker: str | None = None,
    timeframe: str | None = None,
    limit: int = 100,
    latest_cycle_only: bool = True,
) -> list[dict]:
    """Return composite alerts.

    When *latest_cycle_only* is True (default) only rows whose cycle_ts equals
    the most-recent cycle_ts for that ticker are returned — this ensures the
    UI always shows fresh alerts from the last scheduler run, not accumulated
    history from previous cycles.
    """
    import json as _json
    params: list = []

    if latest_cycle_only:
        # Sub-select the latest cycle_ts per ticker (optionally scoped to a TF),
        # then join back. This ensures the UI always shows fresh alerts from
        # the last scheduler run for the requested timeframe.
        tf_clause = "AND timeframe = ?" if timeframe else ""
        if ticker and timeframe:
            sql = (
                "SELECT ca.* FROM composite_alerts ca "
                "WHERE ca.ticker = ? AND ca.timeframe = ? "
                "AND ca.cycle_ts = (SELECT MAX(cycle_ts) FROM composite_alerts "
                "                   WHERE ticker = ? AND timeframe = ?) "
                "ORDER BY ca.timestamp DESC LIMIT ?"
            )
            params = [ticker.upper(), timeframe, ticker.upper(), timeframe, limit]
        elif ticker:
            sql = (
                "SELECT ca.* FROM composite_alerts ca "
                "WHERE ca.ticker = ? "
                "AND ca.cycle_ts = (SELECT MAX(cycle_ts) FROM composite_alerts WHERE ticker = ?) "
                "ORDER BY ca.timestamp DESC LIMIT ?"
            )
            params = [ticker.upper(), ticker.upper(), limit]
        elif timeframe:
            sql = (
                "WITH latest AS ("
                "  SELECT ticker, MAX(cycle_ts) AS max_cycle FROM composite_alerts "
                "  WHERE timeframe = ? GROUP BY ticker"
                ") "
                "SELECT ca.* FROM composite_alerts ca "
                "JOIN latest l ON ca.ticker = l.ticker AND ca.cycle_ts = l.max_cycle "
                "WHERE ca.timeframe = ? "
                "ORDER BY ca.timestamp DESC LIMIT ?"
            )
            params = [timeframe, timeframe, limit]
        else:
            sql = (
                "WITH latest AS ("
                "  SELECT ticker, MAX(cycle_ts) AS max_cycle FROM composite_alerts GROUP BY ticker"
                ") "
                "SELECT ca.* FROM composite_alerts ca "
                "JOIN latest l ON ca.ticker = l.ticker AND ca.cycle_ts = l.max_cycle "
                "ORDER BY ca.timestamp DESC LIMIT ?"
            )
            params = [limit]
    else:
        conditions = []
        if ticker:
            conditions.append("ticker = ?")
            params.append(ticker.upper())
        if timeframe:
            conditions.append("timeframe = ?")
            params.append(timeframe)
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        sql = f"SELECT * FROM composite_alerts {where} ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)

    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        rows = await conn.execute_fetchall(sql, params)
    result = []
    for r in rows:
        d = dict(r)
        try:
            d["components"] = _json.loads(d["components"] or "[]")
        except Exception:
            d["components"] = []
        try:
            extra = _json.loads(d.get("extra") or "{}")
            d.update(extra)
        except Exception:
            pass
        d.pop("extra", None)
        result.append(d)
    return result


# ---------------------------------------------------------------------------
# Session management + login audit log
# ---------------------------------------------------------------------------
from datetime import datetime, timedelta, timezone as _tz  # noqa: E402 — keep near usage


async def create_session(session_id: str, username: str, ip: str, ua: str) -> None:
    now = datetime.now(_tz.utc).isoformat()
    conn = await _get_write_conn()
    async with _write_lock:
        await conn.execute(
            "INSERT OR REPLACE INTO sessions "
            "(id, username, ip_address, user_agent, created_at, last_seen, is_active) "
            "VALUES (?, ?, ?, ?, ?, ?, 1)",
            (session_id, username, ip, ua, now, now),
        )
        await conn.commit()


_SESSION_IDLE_SECS = 2 * 3600  # 2 hours idle → auto-expire


async def expire_idle_sessions() -> int:
    """Mark sessions idle for too long as inactive."""
    cutoff = (datetime.now(_tz.utc) - timedelta(seconds=_SESSION_IDLE_SECS)).isoformat()
    conn = await _get_write_conn()
    async with _write_lock:
        cur = await conn.execute(
            "UPDATE sessions SET is_active=0 WHERE is_active=1 AND last_seen < ?",
            (cutoff,),
        )
        await conn.commit()
        return cur.rowcount or 0


async def get_session_user(session_id: str) -> str | None:
    """Validate session is active and not idle, update last_seen, return username or None."""
    now = datetime.now(_tz.utc)
    now_iso = now.isoformat()
    conn = await _get_write_conn()
    async with _write_lock:
        async with conn.execute(
            "SELECT username, last_seen FROM sessions WHERE id=? AND is_active=1", (session_id,)
        ) as cur:
            row = await cur.fetchone()
        if not row:
            return None
        # Expire idle sessions
        try:
            last_str = row["last_seen"]
            if last_str.endswith("Z"):
                last_str = last_str[:-1] + "+00:00"
            last = datetime.fromisoformat(last_str)
            if last.tzinfo is None:
                last = last.replace(tzinfo=_tz.utc)
            if (now - last).total_seconds() > _SESSION_IDLE_SECS:
                await conn.execute("UPDATE sessions SET is_active=0 WHERE id=?", (session_id,))
                await conn.commit()
                return None
        except Exception:
            pass  # malformed timestamp — let request through
        await conn.execute("UPDATE sessions SET last_seen=? WHERE id=?", (now_iso, session_id))
        await conn.commit()
        return row["username"]


async def deactivate_session(session_id: str) -> None:
    conn = await _get_write_conn()
    async with _write_lock:
        await conn.execute("UPDATE sessions SET is_active=0 WHERE id=?", (session_id,))
        await conn.commit()


async def count_active_sessions(username: str) -> int:
    await expire_idle_sessions()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT COUNT(*) AS cnt FROM sessions WHERE username=? AND is_active=1",
            (username,),
        ) as cur:
            row = await cur.fetchone()
        return int(row["cnt"]) if row else 0


async def list_sessions() -> list[dict]:
    await expire_idle_sessions()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, username, ip_address, user_agent, created_at, last_seen, is_active "
            "FROM sessions ORDER BY last_seen DESC LIMIT 200"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def log_login(username: str, ip: str, ua: str, success: bool) -> None:
    now = datetime.now(_tz.utc).isoformat()
    cutoff = (datetime.now(_tz.utc) - timedelta(days=7)).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO login_log (username, ip_address, user_agent, success, ts) "
            "VALUES (?, ?, ?, ?, ?)",
            (username, ip, ua, 1 if success else 0, now),
        )
        await db.execute("DELETE FROM login_log WHERE ts < ?", (cutoff,))
        await db.commit()


async def get_login_history(limit: int = 50) -> list[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT username, ip_address, user_agent, success, ts "
            "FROM login_log ORDER BY ts DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Push subscriptions
# ---------------------------------------------------------------------------

async def save_push_subscription(endpoint: str, p256dh: str, auth: str, tickers: list[str] | None = None) -> None:
    import json as _json
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO push_subscriptions (endpoint, p256dh, auth, tickers) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, tickers=excluded.tickers",
            (endpoint, p256dh, auth, _json.dumps(tickers) if tickers is not None else None),
        )
        await db.commit()


async def delete_push_subscription(endpoint: str) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
        await db.commit()


async def get_all_push_subscriptions() -> list[dict]:
    import json as _json
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        rows = await db.execute_fetchall("SELECT endpoint, p256dh, auth, tickers FROM push_subscriptions")
    result = []
    for r in rows:
        d = dict(r)
        try:
            d["tickers"] = _json.loads(d["tickers"]) if d["tickers"] else None
        except Exception:
            d["tickers"] = None
        result.append(d)
    return result

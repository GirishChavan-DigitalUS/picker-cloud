# Plan: NYSE Ticker Dashboard with TradingView MCP

## TL;DR
Build a local web app (FastAPI + React/Vite) that fetches 5-min OHLCV data for 9 NYSE tickers via the TradingView MCP (connected to TradingView Desktop via CDP), computes technical indicators, renders TradingView Lightweight Charts with overlays, and runs a rule-based + ML AI evaluator every 5 minutes.

## Architecture

```
React + Vite (pnpm)  ←WebSocket/REST→  FastAPI Backend  ←asyncio MCP client (stdio)→  TradingView MCP (Node.js)  ←CDP:9222→  TradingView Desktop
                                              ↕
                                          SQLite DB
```

## Prerequisites
- TradingView Desktop with paid subscription, launched with `--remote-debugging-port=9222`
- TradingView MCP Jackson cloned and installed (`npm install`)
- Python 3.11+, Node.js 18+, pnpm

---

## Phase 1: Project Scaffolding & Database (parallel frontend + backend)

### Step 1a — Backend init
- Create `backend/` with FastAPI project: `main.py`, `requirements.txt`
- Dependencies: `fastapi`, `uvicorn[standard]`, `mcp`, `pandas`, `numpy`, `scikit-learn`, `aiosqlite`, `websockets`
- Module structure:
  ```
  backend/
    main.py              # FastAPI app, lifespan, CORS
    config.py            # Tickers list, session hours, MCP server path
    db.py                # SQLite init, connection pool (aiosqlite)
    scheduler.py         # APScheduler: 5-min tick for data fetch + AI eval
    mcp_client.py        # TradingView MCP client wrapper
    indicators/
      ema.py
      vwap.py
      trend.py
      volume_profile.py
      support_resistance.py
      swings.py
    signals/
      crossover.py
      vwap_motion.py
      sr_breaks.py
    ai/
      rule_engine.py
      ml_model.py
      evaluator.py
      schemas.py          # Pydantic models for AI JSON contract
    api/
      routes_candles.py
      routes_indicators.py
      routes_signals.py
      routes_predictions.py
      ws.py               # WebSocket endpoint
  ```

### Step 1b — Frontend init (parallel with 1a)
- `pnpm create vite frontend --template react-ts`
- Install: `lightweight-charts`, `zustand`, `axios`, `reconnecting-websocket`
- Module structure:
  ```
  frontend/
    src/
      components/
        Dashboard/
          TickerGrid.tsx        # Main grid table
          TickerRow.tsx         # One row per ticker
        Chart/
          CandlestickChart.tsx  # TradingView Lightweight Charts wrapper
          ChartOverlays.tsx     # EMA, VWAP, S/R line overlays
          SwingMarkers.tsx      # Swing high/low markers
        Detail/
          TickerDetail.tsx      # Per-ticker detail view on row click
        Alerts/
          AlertsPanel.tsx       # Event stream panel
        AI/
          PredictionCard.tsx    # AI prediction display per ticker
      stores/
        marketStore.ts          # Zustand: candles, indicators, signals
        wsStore.ts              # Zustand: WebSocket connection + live updates
      hooks/
        useWebSocket.ts
      utils/
        sessionClassifier.ts   # Client-side session label
        formatters.ts
      App.tsx
      main.tsx
  ```

### Step 1c — SQLite schema
- Tables:
  - `candles` (ticker, timestamp, open, high, low, close, volume, timeframe, session)
  - `indicators` (ticker, timestamp, ema9, ema21, vwap, poc, nearest_support, nearest_resistance, swing_high, swing_high_ts, swing_low, swing_low_ts, daily_trend)
  - `signals` (id, ticker, timestamp, signal_type, direction, details_json)
  - `predictions` (id, ticker, timestamp, prediction, confidence, evidence_json, rules_triggered_json, outcome, outcome_timestamp)

---

## Phase 2: TradingView MCP Data Layer

### Step 2a — MCP client wrapper (`mcp_client.py`)
- Use `mcp` pip package: `StdioServerParameters` + `stdio_client` + `ClientSession`
- Spawn `node <path>/tradingview-mcp-jackson/src/server.js` as subprocess
- Keep persistent session open during app lifetime (init at FastAPI lifespan startup, close on shutdown)
- Expose async methods:
  - `set_symbol(ticker: str)` → calls `chart_set_symbol`
  - `set_timeframe(tf: str)` → calls `chart_set_timeframe`
  - `get_ohlcv(limit: int)` → calls `data_get_ohlcv`, returns list of OHLCV dicts
  - `get_quote()` → calls `quote_get`, returns current price
  - `get_study_values()` → calls `data_get_study_values` (for cross-validation)
- Add lock/semaphore since TradingView Desktop has one active chart — serialize all symbol switches

### Step 2b — Data fetcher service (`scheduler.py`)
- Every 5 minutes (using APScheduler or `asyncio` loop):
  1. For each of 9 tickers (sequentially, due to single chart constraint):
     - `set_symbol(ticker)` → `set_timeframe("5")` → `get_ohlcv(limit=100)`
     - Upsert new candles into `candles` table
     - `get_quote()` for latest price
  2. Estimated cycle time: ~30-45 seconds for all 9 tickers
- Session classifier: classify each candle's session based on its timestamp vs ET market hours:
  - Pre-market: 04:00-09:30 ET
  - Regular: 09:30-16:00 ET
  - After-hours: 16:00-20:00 ET

### Step 2c — Health check endpoint
- `/api/health` → checks MCP connection status, TradingView Desktop connectivity

---

## Phase 3: Indicator Computation Library

All indicators computed in Python from SQLite candle data using pandas/numpy. Run after each data fetch cycle.

### Step 3a — EMA crossover (`indicators/ema.py`)
- Compute EMA-9 and EMA-21 on 5-min close prices per ticker
- Use pandas `ewm(span=N, adjust=False).mean()` — matches TradingView's EMA formula
- Detect crossover: compare current vs previous bar's EMA relationship
- Store: ema9, ema21, ema_state (BULLISH/BEARISH), last crossover timestamp

### Step 3b — Session-aware VWAP (`indicators/vwap.py`)
- Reset VWAP at each session boundary (pre/regular/after)
- Formula: `cumsum(typical_price * volume) / cumsum(volume)` where `typical_price = (H+L+C)/3`
- Compute: price vs VWAP (above/below), distance %, toward/away (compare current distance vs prev bar), VWAP slope

### Step 3c — Daily trend (`indicators/trend.py`)
- Look at daily-aggregated data (aggregate 5-min candles to daily)
- Detect higher-highs/higher-lows pattern → BULL
- Detect lower-highs/lower-lows → BEAR
- Otherwise → NEUTRAL
- Optional: ATR-based trend strength

### Step 3d — Volume profile + POC (`indicators/volume_profile.py`)
- For current session's 5-min candles: bucket prices into bins, sum volume per bin
- POC = price level with highest volume
- Store POC value per ticker per session

### Step 3e — Support/Resistance (`indicators/support_resistance.py`)
- Pivot-based S/R using swing highs/lows (from step 3f)
- Multi-timeframe: aggregate candles to 1h and daily, compute pivot S/R at each
- Assign strength score based on touch count
- Store multiple levels sorted by proximity to current price

### Step 3f — Swing High/Low (`indicators/swings.py`)
- Pivot detection: left=3, right=3 window on 5-min candles
- A bar is swing high if its high > all 3 bars left and right
- A bar is swing low if its low < all 3 bars left and right
- Store latest swing high/low + their timestamps

---

## Phase 4: Signal Generation

### Step 4a — EMA crossover signals (`signals/crossover.py`)
- Emit signal when EMA state flips (bullish→bearish or vice versa)
- Store in `signals` table with timestamp

### Step 4b — VWAP motion signals (`signals/vwap_motion.py`)
- Detect VWAP reclaim (price crosses above VWAP) and breakdown (crosses below)
- Emit signals on these events

### Step 4c — S/R break signals (`signals/sr_breaks.py`)
- When price breaks above resistance or below support, emit signal
- Include which level was broken and its strength

### Step 4d — Swing signals
- When new swing high/low is confirmed, emit signal

All signals broadcast via WebSocket to frontend.

---

## Phase 5: AI Evaluator

### Step 5a — Pydantic schema (`ai/schemas.py`)
- Define `PredictionOutput` model matching the JSON schema from the spec
- Enforce: prediction must be UP/DOWN/NEUTRAL/ABSTAIN, confidence 0.0-1.0, evidence fields required

### Step 5b — Rule-based engine (`ai/rule_engine.py`)
- Deterministic rules, e.g.:
  - EMA bullish + price above VWAP + VWAP moving away upward + bullish trend → UP (confidence based on how many align)
  - EMA bearish + price below VWAP + bearish trend → DOWN
  - Mixed signals or insufficient data → ABSTAIN
- Each rule produces a named trigger string for `rules_triggered`
- Confidence = count of agreeing signals / total signals

### Step 5c — ML scaffold (`ai/ml_model.py`)
- Feature vector: ema9, ema21, ema_state (encoded), vwap_distance_pct, vwap_motion (encoded), daily_trend (encoded), price_vs_poc, distance_to_support, distance_to_resistance, recent_return_5m, recent_volatility
- Model: scikit-learn LogisticRegression or GradientBoostingClassifier
- Training: from stored historical candles + outcomes (did price go up/down in next 1-3 bars?)
- Prediction blended with rule engine (rule engine as primary, ML as secondary signal)
- Fallback to rule-only if insufficient training data (<500 samples)

### Step 5d — Evaluator runner (`ai/evaluator.py`)
- Called by scheduler every 5 minutes per ticker
- Gathers all indicator values → runs rule engine → optionally runs ML → produces `PredictionOutput`
- Logs prediction to `predictions` table
- After outcome is known (3 bars later), updates `outcome` field for accuracy tracking

---

## Phase 6: API & Real-time

### Step 6a — REST endpoints (`api/routes_*.py`)
- `GET /api/candles/{ticker}?timeframe=5m&limit=200` → OHLCV data
- `GET /api/indicators/{ticker}` → latest indicator snapshot
- `GET /api/indicators/{ticker}/history?limit=200` → indicator time series for chart overlay
- `GET /api/signals?ticker=&type=&limit=50` → recent signals
- `GET /api/predictions/{ticker}` → latest + historical predictions
- `GET /api/predictions/{ticker}/accuracy` → accuracy metrics
- `GET /api/dashboard` → aggregated view (all tickers, latest indicators, latest prediction)

### Step 6b — WebSocket (`api/ws.py`)
- `ws://localhost:8000/ws` — pushes:
  - Price updates (after each fetch cycle)
  - New signals (EMA cross, VWAP events, S/R breaks, swings)
  - New predictions
- Use FastAPI WebSocket with Zustand store on frontend

### Step 6c — Scheduler integration
- APScheduler or background asyncio task
- Every 5 min: fetch data → compute indicators → generate signals → run AI evaluator → broadcast via WS
- Stagger per ticker to avoid burst load

---

## Phase 7: Frontend Dashboard

### Step 7a — Dashboard grid (`TickerGrid.tsx` + `TickerRow.tsx`)
- Table with columns: Ticker, Price, Session, EMA State, EMA Cross Time, VWAP Position, VWAP Distance, VWAP Motion, Trend, POC, Support, Resistance, Swing High, Swing Low, AI Prediction, Confidence
- Color coding: green for bullish signals, red for bearish, gray for neutral
- Row click → open detail view

### Step 7b — TradingView Lightweight Charts (`CandlestickChart.tsx`)
- `createChart()` with dark theme
- `CandlestickSeries` for 5-min OHLCV
- `LineSeries` overlays: EMA9 (blue), EMA21 (orange), VWAP (purple)
- Horizontal price lines for S/R levels (using `createPriceLine()`)
- Markers for swing highs (▼) and swing lows (▲)
- Real-time updates via `series.update()` on WebSocket messages

### Step 7c — Detail view (`TickerDetail.tsx`)
- Full-width chart + all indicators
- AI prediction card with evidence breakdown
- Signal history list

### Step 7d — Alerts panel (`AlertsPanel.tsx`)
- Scrollable event stream
- Filter by ticker or signal type
- Auto-scroll to newest

### Step 7e — Zustand stores
- `marketStore`: candles, indicators, signals per ticker — updated from REST (initial load) + WS (live)
- `wsStore`: WebSocket connection management, reconnection logic

---

## Relevant Files (to create)

### Backend
- `backend/main.py` — FastAPI app with lifespan, CORS, router includes
- `backend/config.py` — TICKERS list, session hours (ET), MCP server path, DB path
- `backend/db.py` — SQLite schema creation, `aiosqlite` connection helpers
- `backend/mcp_client.py` — TradingView MCP client wrapper (async, singleton)
- `backend/scheduler.py` — Data fetch + indicator compute + AI eval loop
- `backend/indicators/*.py` — One module per indicator (6 files)
- `backend/signals/*.py` — One module per signal type (4 files)
- `backend/ai/schemas.py` — Pydantic `PredictionOutput` model
- `backend/ai/rule_engine.py` — Deterministic rule evaluator
- `backend/ai/ml_model.py` — scikit-learn ML scaffold
- `backend/ai/evaluator.py` — Orchestrator that combines rule + ML
- `backend/api/routes_*.py` — REST routes (4 files)
- `backend/api/ws.py` — WebSocket broadcast manager

### Frontend
- `frontend/src/App.tsx` — Layout with grid + alerts panel
- `frontend/src/components/Dashboard/TickerGrid.tsx` — Main table
- `frontend/src/components/Dashboard/TickerRow.tsx` — Per-ticker row
- `frontend/src/components/Chart/CandlestickChart.tsx` — TradingView LW Charts
- `frontend/src/components/Detail/TickerDetail.tsx` — Per-ticker detail
- `frontend/src/components/Alerts/AlertsPanel.tsx` — Signal stream
- `frontend/src/components/AI/PredictionCard.tsx` — AI output display
- `frontend/src/stores/marketStore.ts` — Zustand state
- `frontend/src/stores/wsStore.ts` — WebSocket state
- `frontend/src/hooks/useWebSocket.ts` — WS connection hook

---

## Verification

1. **MCP connection**: Start TradingView Desktop with CDP, run `backend/mcp_client.py` standalone — verify `data_get_ohlcv` returns data for SPY
2. **Indicator accuracy**: Cross-validate EMA/VWAP against TradingView's `data_get_study_values` for the same ticker/timeframe — values should match within 0.01%
3. **Unit tests**: `pytest` tests for each indicator module with known input/output (e.g., EMA of [1,2,3,4,5] with span=3)
4. **API smoke test**: `curl localhost:8000/api/dashboard` returns valid JSON with all 9 tickers
5. **WebSocket**: Open browser console, connect to `ws://localhost:8000/ws`, verify signals arrive within one fetch cycle (~1 min)
6. **AI contract**: Verify every prediction output passes Pydantic validation, confidence is 0-1, ABSTAIN emitted when signals conflict
7. **Frontend render**: All 9 rows visible in grid, charts render candles + overlays, clicking a row opens detail view
8. **End-to-end**: Run during regular market hours — observe price updates, indicator changes, AI predictions logged

---

## Decisions
- **Backend**: Python (FastAPI) — chosen for NumPy/Pandas indicator math
- **Data source**: TradingView MCP Jackson via `mcp` pip package (stdio transport to Node.js subprocess)
- **Single-chart constraint**: TradingView Desktop shows one chart — we serialize symbol switches with an asyncio lock; ~30-45s cycle for all 9 tickers
- **Frontend**: React + Vite + pnpm + TypeScript
- **State management**: Zustand (lighter than Redux for this use case)
- **Charts**: TradingView Lightweight Charts v5.x
- **AI**: Rule-based primary + scikit-learn ML scaffold (logistic regression / gradient boosting)
- **DB**: SQLite via aiosqlite (async, no separate server)
- **Scheduler**: Background asyncio task in FastAPI lifespan (simpler than APScheduler for this)

## Further Considerations
1. **TradingView MCP session persistence**: The MCP client connection should stay alive for the app lifetime. If it drops (TradingView restart), the scheduler should detect and reconnect. Plan includes health check but we should add auto-reconnect logic.
2. **SPX data**: SPX is an index, not directly tradable. TradingView supports it but confirm the MCP can read OHLCV for `SPX` (may need `SP:SPX` or `CBOE:SPX` symbol format). Will need to verify during Phase 2.
3. **Historical data bootstrap**: On first launch, we need to backfill enough 5-min candles for indicator warm-up (e.g., EMA-21 needs at least 21 bars). The MCP's `data_get_ohlcv` with `limit=200` should provide ~16 hours of 5-min data — sufficient for a trading day.

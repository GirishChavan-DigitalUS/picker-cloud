## Setup & Run Instructions

### Prerequisites
1. TradingView Desktop app (paid subscription) — must be running
2. Node.js 18+, Python 3.11+, pnpm

---

### Step 1: Clone and set up TradingView MCP Jackson

```bash
git clone https://github.com/LewisWJackson/tradingview-mcp-jackson.git ~/tradingview-mcp-jackson
cd ~/tradingview-mcp-jackson
npm install
```

---

### Step 2: Launch TradingView Desktop with CDP debug port

**Windows:**
```
tradingview-mcp-jackson\scripts\launch_tv_debug.bat
```

Or add `--remote-debugging-port=9222` to your TradingView shortcut target.

---

### Step 3: Configure the backend

Edit `backend/config.py`:
- Set `MCP_SERVER_PATH` to your `tradingview-mcp-jackson/src/server.js` path
  (or set env var `TV_MCP_PATH`)
- Optionally set `DB_PATH` to change the SQLite database location

---

### Step 4: Install Python dependencies

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate   # Windows
pip install -r requirements.txt
```

---

### Step 5: Run the backend

```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

The backend will:
- Connect to the TradingView MCP server
- Create the SQLite database (`picker.db`)
- Start the 5-minute fetch scheduler immediately on first run
- Serve the API at `http://localhost:8000`
- Serve WebSocket at `ws://localhost:8000/ws`

Check health: `http://localhost:8000/api/health`

---

### Step 6: Run the frontend

```bash
cd frontend
pnpm install   # already done if you ran pnpm install earlier
pnpm dev
```

Open `http://localhost:5173`

---

### API Reference

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | MCP connection status |
| `GET /api/dashboard` | All 9 tickers — latest indicators + predictions |
| `GET /api/candles/{ticker}?limit=200` | OHLCV bars |
| `GET /api/indicators/{ticker}` | Latest indicator snapshot |
| `GET /api/indicators/{ticker}/history` | Indicator time series |
| `GET /api/signals?ticker=&type=` | Recent signals |
| `GET /api/predictions/{ticker}` | AI predictions |
| `GET /api/predictions/{ticker}/accuracy` | Accuracy metrics |
| `WS  ws://localhost:8000/ws` | Live updates: price, signals, predictions |

---

### Verifying indicator accuracy

The backend uses TradingView's own chart data (via MCP), so indicator values
should match exactly what TradingView shows. To cross-validate EMA/VWAP:

1. Open TradingView Desktop, add EMA(9), EMA(21), VWAP to the chart
2. Call `GET /api/indicators/SPY` and compare values
3. Values should match within rounding (0.01%)

---

### Env vars (optional overrides)

| Variable | Default | Description |
|----------|---------|-------------|
| `TV_MCP_PATH` | `~/tradingview-mcp-jackson/src/server.js` | Path to MCP server |
| `DB_PATH` | `backend/picker.db` | SQLite database path |
| `FETCH_INTERVAL` | `300` | Fetch interval in seconds |

---

### HTTP Basic Auth (production)

The deployed nginx config gates the dashboard, `/api/*`, and `/ws` behind
HTTP Basic Auth. The marketing pages (`/landing.html`, `/architecture.html`)
and `/api/health` are left public for sharing and uptime monitoring.

Credentials live in `/etc/nginx/.htpasswd-picker` on the EC2 host and are
**never** committed to git (see `.gitignore`).

Initial setup / rotation:

```bash
# On the EC2 host, after deploy.sh has installed nginx + the picker config:
sudo /opt/picker/deploy/setup-auth.sh           # interactive prompt
# or:
sudo /opt/picker/deploy/setup-auth.sh admin     # prompts for password only
```

The script installs `htpasswd` if missing, writes a bcrypt-hashed entry, sets
file permissions to `640 root:nginx`, then runs `nginx -t && systemctl reload
nginx`. Re-run any time to add/update users.

To remove a user:

```bash
sudo htpasswd -D /etc/nginx/.htpasswd-picker <username>
sudo nginx -t && sudo systemctl reload nginx
```

The nginx config also applies a per-IP rate limit (30 req/s, burst 60) to
deter casual scraping / DDoS-lite. Adjust the `limit_req_zone` line in
`deploy/nginx-https.conf` if your traffic profile differs.

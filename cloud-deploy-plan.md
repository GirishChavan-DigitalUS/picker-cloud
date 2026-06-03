# Plan: Migrate Picker App to AWS Cloud

## TL;DR
Migrate the NYSE Ticker Dashboard (FastAPI backend + React frontend) to a single **EC2 t2.micro** instance with an auto start/stop schedule (8 AM - 8 PM ET). This is the optimal approach because the app's architecture (WebSocket, background scheduler, SQLite, ML training) is inherently stateful and long-running — a natural fit for EC2 rather than serverless. Total cost: **~$1.73/month** within free tier (or $0 without Elastic IP).

## Why EC2 over Serverless

| Concern | EC2 t2.micro | Serverless (Lambda + API GW) |
|---------|-------------|------------------------------|
| Code changes | Minimal (config only) | Major refactoring |
| WebSocket | Native, works as-is | API GW WebSocket: 10-min idle timeout, 2-hr max, costs $0.25/M conn-minutes (no free tier) |
| Scheduler (60s loop) | Works as-is (asyncio) | EventBridge + Lambda: 10 tickers × 1440 calls/day = 432K invocations/month (eats free tier) |
| SQLite | Works on EBS | Must migrate to DynamoDB (significant schema rewrite) |
| ML training | Works in-process | Lambda memory limits, cold starts, needs S3 for model |
| Free tier | 750 hrs/month (12 months) | 1M requests always-free, BUT WebSocket/DynamoDB add costs |
| Maintenance | OS updates, restarts | Zero server management |
| Post-free-tier cost | ~$8-10/month (t2.micro) | ~$2-5/month (depends on usage) |

**Verdict: EC2** — minimal migration effort, $0 cost for 12 months, no code refactoring needed.

---

## Architecture

```
Internet
  │
  ▼
EC2 t2.micro (Elastic IP) — Amazon Linux 2023
  │
  ├── Nginx (port 80)
  │     ├── / → serves frontend dist/ (static files)
  │     ├── /api/* → proxy_pass http://127.0.0.1:8000
  │     └── /ws → proxy_pass ws://127.0.0.1:8000/ws
  │
  └── Uvicorn (port 8000, localhost only)
        ├── FastAPI app
        ├── SQLite (picker.db on EBS)
        ├── Scheduler (asyncio background task)
        └── ML model (picker_ml_model.pkl on EBS)

Auto Start/Stop:
  EventBridge Rule → Lambda → EC2 Start (7:45 AM ET) / Stop (8:15 PM ET)
```

## Steps

### Phase 1: AWS Infrastructure (EC2 + Networking)

1. **Launch EC2 instance**
   - AMI: Amazon Linux 2023 (free tier eligible)
   - Instance type: t2.micro (1 vCPU, 1GB RAM)
   - Storage: 8GB gp3 EBS (free tier: 30GB)
   - Key pair: Create new RSA key pair for SSH
   - Region: us-east-1 (best free tier availability)

2. **Configure Security Group** (inbound rules)
   - Port 80 (HTTP): 0.0.0.0/0 (public access)
   - Port 22 (SSH): Your IP only (management)
   - All outbound: allowed (yFinance API, LLM APIs)

3. **Allocate Elastic IP** and associate with EC2 instance
   - Free when attached to a running instance
   - Provides stable public IP for bookmarking

4. **Create IAM role for EC2** with CloudWatch Logs permissions (optional, for log shipping)

### Phase 2: Server Setup (on EC2)

5. **Install system dependencies** (via SSH or bootstrap.sh user data script)
   - Python 3.11, pip, git, nginx
   - Node.js 18+ and pnpm (for frontend build)

6. **Clone repository** and install backend dependencies
   - `cd /opt/picker && git clone <repo>`
   - `pip install -r backend/requirements.txt`

7. **Configure environment variables**
   - Create `/opt/picker/.env` with: LLM_PROVIDER, LLM_API_KEY (if using Gemini free tier), DB_PATH
   - Backend auto-loads `.env` via python-dotenv

8. **Create systemd service** for the backend
   - Service: `picker-backend.service`
   - ExecStart: `uvicorn main:app --host 127.0.0.1 --port 8000`
   - WorkingDirectory: `/opt/picker/backend`
   - Auto-restart on failure
   - Starts after network is up

### Phase 3: Frontend Build & Nginx

9. **Build frontend** (once src/ is implemented)
   - `cd /opt/picker/frontend && pnpm install && pnpm build`
   - Output: `/opt/picker/frontend/dist/`

10. **Configure Nginx** as reverse proxy + static server
    - Serve `/opt/picker/frontend/dist/` at root `/`
    - Proxy `/api/` to `http://127.0.0.1:8000/api/`
    - Proxy `/ws` to `ws://127.0.0.1:8000/ws` (with WebSocket upgrade headers)
    - Enable gzip compression

### Phase 4: Backend Code Changes (already applied)

11. **CORS origins** in `backend/main.py`
    - Now reads `ALLOWED_ORIGINS` env var (comma-separated)
    - Falls back to localhost origins for local dev

12. **`.env` file support** in `backend/config.py`
    - Uses `python-dotenv` to auto-load `.env` from project root
    - All settings already read from `os.environ`

13. **Frontend API base URL**
    - Use relative URLs (`/api/...`, `/ws`) so Nginx proxying works
    - No hardcoded localhost in production

### Phase 5: Auto Start/Stop Schedule (cost optimization)

14. **Create IAM role** for Lambda with `ec2:StartInstances` and `ec2:StopInstances` permissions

15. **Create two Lambda functions** (Python 3.12 runtime)
    - `picker-ec2-start`: calls `ec2.start_instances(InstanceIds=[INSTANCE_ID])`
    - `picker-ec2-stop`: calls `ec2.stop_instances(InstanceIds=[INSTANCE_ID])`
    - Source code in `deploy/lambda/`

16. **Create EventBridge Scheduler rules**
    - Start rule: `cron(45 11 ? * MON-SUN *)` (7:45 AM ET = 11:45 UTC)
    - Stop rule: `cron(15 0 ? * TUE-MON *)` (8:15 PM ET = 00:15+1 UTC)
    - Target: respective Lambda functions
    - This gives ~12.5 hrs/day × 30 = ~375 hrs/month (within 750 free tier hours)

### Phase 6: Deployment

17. **First-time bootstrap**: Run `deploy/bootstrap.sh` as EC2 user data or via SSH
18. **Subsequent deploys**: Run `deploy/deploy.sh` from your local machine

---

## Deployment Files

| File | Purpose |
|------|---------|
| `deploy/bootstrap.sh` | First-time EC2 setup (idempotent) |
| `deploy/deploy.sh` | Subsequent code deployments from local machine |
| `deploy/nginx.conf` | Nginx reverse proxy + static file config |
| `deploy/picker-backend.service` | systemd unit file for the backend |
| `deploy/lambda/ec2_start.py` | Lambda function to start EC2 |
| `deploy/lambda/ec2_stop.py` | Lambda function to stop EC2 |

---

## Verification

1. **Health check**: `curl http://<ELASTIC_IP>/api/health` → `{"status": "ok", "data_source": "yfinance"}`
2. **Frontend**: Open `http://<ELASTIC_IP>` in browser → dashboard loads
3. **WebSocket**: Browser dev tools → `ws://<ELASTIC_IP>/ws` connects and receives `price_update` messages
4. **Scheduler**: After 60s, `GET /api/candles/SPY` returns data
5. **Predictions**: After ~5 min, `GET /api/predictions/SPY` returns AI predictions
6. **Auto start/stop**: EC2 stops at 8:15 PM ET, starts at 7:45 AM ET
7. **Public access**: Access from a different network/device
8. **Systemd recovery**: `sudo systemctl stop picker-backend` → auto-restarts

---

## Decisions

- **EC2 over Serverless**: WebSocket, scheduler, SQLite, ML training are all stateful — serverless requires major refactoring
- **Single instance**: Acceptable for a public dashboard (not mission-critical trading execution)
- **No HTTPS initially**: Let's Encrypt requires a domain. Add later with free DuckDNS subdomain
- **No ALB**: Costs ~$16/month, unnecessary for single instance
- **No RDS**: SQLite is sufficient; RDS adds complexity with no benefit
- **yFinance**: No TradingView Desktop needed on cloud
- **Elastic IP**: Free while running; $0.005/hr when stopped (~$1.73/month for idle hours)

## Cost Breakdown (Monthly, Free Tier)

| Service | Usage | Free Tier Limit | Cost |
|---------|-------|----------------|------|
| EC2 t2.micro | ~375 hrs/month | 750 hrs/month | $0 |
| EBS gp3 8GB | 8GB | 30GB | $0 |
| Elastic IP (stopped hours) | ~345 hrs stopped | N/A | ~$1.73/month |
| Lambda (start/stop) | 60 invocations | 1M/month | $0 |
| EventBridge | 60 rules triggered | 14M/month | $0 |
| Data transfer (out) | <1GB | 100GB/month | $0 |
| **Total** | | | **~$1.73/month** |

> To avoid the Elastic IP idle charge, skip the Elastic IP and use the dynamic public IP (changes on restart) — reduces cost to **$0/month**.

## Further Considerations

1. **Elastic IP vs Dynamic IP**: $1.73/month for stable URL vs. $0 with URL changing daily. Use Elastic IP for public access stability.
2. **HTTPS**: Get a free DuckDNS subdomain + Let's Encrypt certbot when ready.
3. **1GB RAM**: Monitor usage; ML training + 10 tickers should fit, but watch for OOM.
4. **Monitoring**: CloudWatch basic monitoring is free (5-min metrics). Set up alarm for disk > 80%.

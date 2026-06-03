#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy latest code to EC2 from your local machine
# Usage: ./deploy/deploy.sh [EC2_HOST] [KEY_PATH]
#   EC2_HOST  — Elastic IP or public DNS (default: env var PICKER_EC2_HOST)
#   KEY_PATH  — Path to SSH private key (default: env var PICKER_SSH_KEY)
#
# Example:
#   ./deploy/deploy.sh 54.123.45.67 ~/.ssh/picker-key.pem
# =============================================================================
set -euo pipefail

EC2_HOST="${1:-${PICKER_EC2_HOST:-}}"
KEY_PATH="${2:-${PICKER_SSH_KEY:-}}"
EC2_USER="ec2-user"
APP_DIR="/opt/picker"

if [ -z "$EC2_HOST" ] || [ -z "$KEY_PATH" ]; then
    echo "Usage: ./deploy/deploy.sh <EC2_HOST> <SSH_KEY_PATH>"
    echo "  or set PICKER_EC2_HOST and PICKER_SSH_KEY env vars"
    exit 1
fi

SSH_CMD="ssh -i $KEY_PATH -o StrictHostKeyChecking=no $EC2_USER@$EC2_HOST"

echo "========== Deploying to $EC2_HOST =========="

# ---------------------------------------------------------------------------
# 1. Pull latest code
# ---------------------------------------------------------------------------
echo "[1/5] Pulling latest code..."
$SSH_CMD "cd $APP_DIR && sudo git fetch origin && sudo git reset --hard origin/main"

# ---------------------------------------------------------------------------
# 2. Install any new Python dependencies
# ---------------------------------------------------------------------------
echo "[2/5] Updating Python dependencies..."
$SSH_CMD "cd $APP_DIR/backend && source venv/bin/activate && pip install -r requirements.txt -q"

# ---------------------------------------------------------------------------
# 3. Build frontend (if src/ exists)
# ---------------------------------------------------------------------------
echo "[3/5] Building frontend..."
$SSH_CMD "cd $APP_DIR/frontend && if [ -d src ]; then pnpm install --frozen-lockfile && pnpm build; else echo 'src/ not found, skipping'; fi"

# ---------------------------------------------------------------------------
# 4. Restart backend service
# ---------------------------------------------------------------------------
echo "[4/5] Restarting backend..."
$SSH_CMD "sudo systemctl restart picker-backend"

# Wait for startup
sleep 3

# ---------------------------------------------------------------------------
# 5. Health check
# ---------------------------------------------------------------------------
echo "[5/5] Health check..."
HEALTH=$($SSH_CMD "curl -sf http://localhost:8000/api/health" 2>&1 || echo "FAILED")
echo "  Response: $HEALTH"

if echo "$HEALTH" | grep -q '"status"'; then
    echo ""
    echo "========== Deploy successful! =========="
    echo "  URL: https://nysepicker.duckdns.org"
else
    echo ""
    echo "========== WARNING: Health check failed =========="
    echo "  Check logs: $SSH_CMD 'sudo journalctl -u picker-backend -n 50'"
    exit 1
fi

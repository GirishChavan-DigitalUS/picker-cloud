#!/usr/bin/env bash
# =============================================================================
# bootstrap.sh — First-time EC2 setup for Picker NYSE Dashboard
# Run as root (EC2 user data) or with sudo.
# Idempotent — safe to re-run.
# =============================================================================
set -euo pipefail

APP_DIR="/opt/picker"
REPO_URL="${PICKER_REPO_URL:-https://github.com/YOUR_USERNAME/picker-cloud.git}"
BRANCH="${PICKER_BRANCH:-main}"

echo "========== Picker Bootstrap — $(date) =========="

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
echo "[1/7] Installing system packages..."
dnf update -y -q
dnf install -y -q git nginx python3.11 python3.11-pip nodejs20

# pnpm (global)
if ! command -v pnpm &>/dev/null; then
    npm install -g pnpm
fi

# Ensure python3 points to 3.11
alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1 2>/dev/null || true

# ---------------------------------------------------------------------------
# 2. Clone or update repository
# ---------------------------------------------------------------------------
echo "[2/7] Setting up application directory..."
if [ -d "$APP_DIR/.git" ]; then
    echo "  Repository exists, pulling latest..."
    cd "$APP_DIR"
    git fetch origin
    git reset --hard "origin/$BRANCH"
else
    echo "  Cloning repository..."
    mkdir -p "$APP_DIR"
    git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

# ---------------------------------------------------------------------------
# 3. Python virtual environment & dependencies
# ---------------------------------------------------------------------------
echo "[3/7] Setting up Python environment..."
cd "$APP_DIR/backend"

if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q

# ---------------------------------------------------------------------------
# 4. Create .env if it doesn't exist
# ---------------------------------------------------------------------------
echo "[4/7] Checking .env file..."
if [ ! -f "$APP_DIR/.env" ]; then
    cat > "$APP_DIR/.env" <<'ENVFILE'
# Picker environment configuration
# Uncomment and set values as needed

DB_PATH=/opt/picker/backend/picker.db

# LLM Commentary (optional)
# LLM_PROVIDER=gemini
# LLM_API_KEY=your-api-key-here
# LLM_MODEL=

# CORS — comma-separated allowed origins
# ALLOWED_ORIGINS=https://nysepicker.duckdns.org

# Scheduler
# FETCH_INTERVAL=60

# Web Push notifications (VAPID) — generate once with: node gen_vapid.cjs
# VAPID_PRIVATE_KEY=
# VAPID_PUBLIC_KEY=
# VAPID_CONTACT_EMAIL=admin@nysepicker.duckdns.org
ENVFILE
    echo "  Created .env — edit /opt/picker/.env to configure"
else
    echo "  .env already exists, skipping"
fi

# ---------------------------------------------------------------------------
# 5. Install systemd service
# ---------------------------------------------------------------------------
echo "[5/7] Installing systemd service..."
cp "$APP_DIR/deploy/picker-backend.service" /etc/systemd/system/picker-backend.service
systemctl daemon-reload
systemctl enable picker-backend
systemctl restart picker-backend

# ---------------------------------------------------------------------------
# 6. Configure Nginx
# ---------------------------------------------------------------------------
echo "[6/7] Configuring Nginx..."
cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/conf.d/picker.conf

# Disable the default AL2023 server block (listens on 80 and conflicts with ours)
sed -i 's/^        listen       80;/        # listen       80;/' /etc/nginx/nginx.conf
sed -i 's/^        listen       \[::\]:80;/        # listen       [::]:80;/' /etc/nginx/nginx.conf

# Remove default server block if it conflicts
if [ -f /etc/nginx/conf.d/default.conf ]; then
    mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.bak
fi

nginx -t
systemctl enable nginx
systemctl restart nginx

# ---------------------------------------------------------------------------
# 7. Build frontend (if src/ exists)
# ---------------------------------------------------------------------------
echo "[7/7] Building frontend..."
cd "$APP_DIR/frontend"
if [ -d "src" ]; then
    pnpm install --frozen-lockfile
    pnpm build
    echo "  Frontend built to dist/"
else
    echo "  Frontend src/ not found — skipping build"
    # Create a placeholder so Nginx doesn't 403
    mkdir -p dist
    echo '<html><body><h1>Picker Dashboard</h1><p>Frontend not yet deployed.</p></body></html>' > dist/index.html
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
# Ensure ec2-user owns everything so the service can write picker.db, logs, etc.
chown -R ec2-user:ec2-user "$APP_DIR"

echo ""
echo "========== Bootstrap complete! =========="
echo "  Backend:  systemctl status picker-backend"
echo "  Nginx:    systemctl status nginx"
echo "  Health:   curl http://localhost/api/health"
echo "  Config:   /opt/picker/.env"
echo ""

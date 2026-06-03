#!/usr/bin/env bash
# =============================================================================
# setup-ssl.sh — One-time HTTPS setup for nysepicker.duckdns.org
#
# Prerequisites (do these BEFORE running this script):
#   1. Register "nysepicker" at https://www.duckdns.org/ (free account)
#      and set its IP to your Elastic IP: 32.198.161.209
#   2. Wait ~1 minute for DNS to propagate. Test with:
#        nslookup nysepicker.duckdns.org
#   3. Ensure port 443 is open in your EC2 Security Group
#      (already done if you used the latest cloudformation.yaml)
#   4. Nginx must be running (bootstrap.sh handles this)
#
# Usage (SSH into EC2 first, then run as root):
#   sudo bash /opt/picker/deploy/setup-ssl.sh your@email.com
# =============================================================================
set -euo pipefail

DOMAIN="nysepicker.duckdns.org"
APP_DIR="/opt/picker"
EMAIL="${1:-}"

if [ -z "$EMAIL" ]; then
    echo "ERROR: An email address is required for Let's Encrypt expiry notifications."
    echo "Usage: sudo bash $0 your@email.com"
    exit 1
fi

echo "========== Picker SSL Setup — $(date) =========="
echo "  Domain: $DOMAIN"
echo "  Email:  $EMAIL"
echo ""

# ---------------------------------------------------------------------------
# 1. Verify DNS points to this machine before requesting a cert
# ---------------------------------------------------------------------------
echo "[1/5] Verifying DNS..."
RESOLVED=$(dig +short "$DOMAIN" | tail -1)
MY_IP=$(curl -sf https://checkip.amazonaws.com || curl -sf https://api.ipify.org || echo "unknown")

if [ "$RESOLVED" != "$MY_IP" ] && [ "$MY_IP" != "unknown" ]; then
    echo ""
    echo "  ERROR: DNS mismatch!"
    echo "    $DOMAIN resolves to: $RESOLVED"
    echo "    This server's IP is: $MY_IP"
    echo ""
    echo "  Update your DuckDNS record to $MY_IP at https://www.duckdns.org/"
    echo "  Then wait ~1 minute and re-run this script."
    exit 1
fi
echo "  DNS OK: $DOMAIN -> $RESOLVED"

# ---------------------------------------------------------------------------
# 2. Install certbot
# ---------------------------------------------------------------------------
echo "[2/5] Installing certbot..."
dnf install -y -q certbot

# ---------------------------------------------------------------------------
# 3. Create ACME webroot directory (already served by nginx.conf)
# ---------------------------------------------------------------------------
echo "[3/5] Preparing ACME challenge directory..."
mkdir -p /var/www/certbot

# ---------------------------------------------------------------------------
# 4. Obtain Let's Encrypt certificate
#    Uses webroot method — nginx stays running the whole time
# ---------------------------------------------------------------------------
echo "[4/5] Obtaining Let's Encrypt certificate..."
certbot certonly \
    --webroot \
    --webroot-path /var/www/certbot \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN"

echo "  Certificate obtained:"
echo "    /etc/letsencrypt/live/$DOMAIN/fullchain.pem"
echo "    /etc/letsencrypt/live/$DOMAIN/privkey.pem"

# ---------------------------------------------------------------------------
# 5. Switch to HTTPS nginx config
# ---------------------------------------------------------------------------
echo "[5/5] Enabling HTTPS nginx config..."
cp "$APP_DIR/deploy/nginx-https.conf" /etc/nginx/conf.d/picker.conf
nginx -t
systemctl reload nginx

# ---------------------------------------------------------------------------
# 6. Set up auto-renewal cron
# ---------------------------------------------------------------------------
echo "[6/5] Configuring auto-renewal..."
cat > /etc/cron.d/certbot-renew <<'CRON'
# Certbot auto-renewal — runs twice daily, reloads nginx if cert was renewed
0 0,12 * * * root certbot renew --quiet --webroot --webroot-path /var/www/certbot --deploy-hook "systemctl reload nginx"
CRON
chmod 644 /etc/cron.d/certbot-renew

echo ""
echo "=========================================="
echo " SSL Setup Complete!"
echo "=========================================="
echo ""
echo "  Dashboard:  https://$DOMAIN"
echo "  API Health: https://$DOMAIN/api/health"
echo ""
echo "  HTTP (port 80) now redirects to HTTPS."
echo "  Certificate auto-renews every ~60 days."
echo ""
echo "  Next: push code and run deploy.sh to go live:"
echo "    git push origin main"
echo "    ./deploy/deploy.sh $DOMAIN ~/.ssh/your-key.pem"

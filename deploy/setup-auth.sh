#!/usr/bin/env bash
# Picker — set / rotate HTTP Basic Auth credentials for the nginx edge.
#
# Run on the EC2 host AFTER deploy.sh has installed nginx + the picker config.
#
# Usage:
#     sudo deploy/setup-auth.sh                  # interactive: prompts for user + password
#     sudo deploy/setup-auth.sh admin            # add/update user "admin", prompt for password
#     sudo deploy/setup-auth.sh admin S3cret!    # non-interactive (avoid in shell history)
#
# Notes:
#   - File: /etc/nginx/.htpasswd-picker (referenced by deploy/nginx*.conf)
#   - First user creates the file (-c). Subsequent calls update/add users.
#   - htpasswd ships with apache2-utils (Debian/Ubuntu) or httpd-tools (Amazon Linux/RHEL).
#   - To remove a user:  sudo htpasswd -D /etc/nginx/.htpasswd-picker <user>
#   - To verify config:  sudo nginx -t && sudo systemctl reload nginx
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo $0 $*" >&2
  exit 1
fi

HTPASSWD_FILE="/etc/nginx/.htpasswd-picker"

# Install htpasswd if missing — and if the package manager is broken (a common
# Amazon Linux failure mode where python3-dnf is missing, breaking both yum and
# dnf), fall back to building the entry with `openssl passwd -apr1`, which
# produces a hash format nginx natively supports.
USE_OPENSSL_FALLBACK=0
if ! command -v htpasswd >/dev/null 2>&1; then
  echo "Installing htpasswd…"
  installed=0
  # Try in order: apt-get (Debian/Ubuntu), yum (Amazon Linux 2 / older RHEL),
  # dnf (Fedora / AL2023). Skip to the next if one fails.
  for pm in apt-get yum dnf; do
    if command -v "$pm" >/dev/null 2>&1; then
      case "$pm" in
        apt-get) apt-get update -qq && apt-get install -y -qq apache2-utils && installed=1 && break ;;
        yum)     yum install -y -q httpd-tools                                && installed=1 && break ;;
        dnf)     dnf install -y -q httpd-tools                                && installed=1 && break ;;
      esac
      echo "  $pm failed, trying next…" >&2
    fi
  done
  if [[ $installed -ne 1 ]] || ! command -v htpasswd >/dev/null 2>&1; then
    if command -v openssl >/dev/null 2>&1; then
      echo "  Package manager unavailable — falling back to 'openssl passwd -apr1'."
      USE_OPENSSL_FALLBACK=1
    else
      echo "Could not install htpasswd and openssl is also missing." >&2
      echo "Install apache2-utils / httpd-tools manually." >&2
      exit 1
    fi
  fi
fi

USER="${1:-}"
PASS="${2:-}"

if [[ -z "$USER" ]]; then
  read -r -p "Username: " USER
fi
if [[ -z "$USER" ]]; then
  echo "Username required." >&2
  exit 1
fi

# Choose create-flag based on whether file exists yet
FLAGS="-B"          # bcrypt (-B) is stronger than the default crypt
if [[ ! -f "$HTPASSWD_FILE" ]]; then
  FLAGS="-Bc"
fi

if [[ $USE_OPENSSL_FALLBACK -eq 1 ]]; then
  # openssl path: ask for password (twice for confirmation) if not supplied,
  # then append "user:apr1-hash" to the file, replacing any existing entry
  # for the same user.
  if [[ -z "$PASS" ]]; then
    read -r -s -p "Password: "         PASS;  echo
    read -r -s -p "Re-enter password: " PASS2; echo
    if [[ "$PASS" != "$PASS2" ]]; then
      echo "Passwords do not match." >&2
      exit 1
    fi
  fi
  HASH=$(openssl passwd -apr1 "$PASS")
  # Strip any existing line for this user, then append the new one.
  TMP=$(mktemp)
  if [[ -f "$HTPASSWD_FILE" ]]; then
    grep -v "^${USER}:" "$HTPASSWD_FILE" > "$TMP" || true
  fi
  echo "${USER}:${HASH}" >> "$TMP"
  install -m 640 "$TMP" "$HTPASSWD_FILE"
  rm -f "$TMP"
elif [[ -n "$PASS" ]]; then
  htpasswd $FLAGS -b "$HTPASSWD_FILE" "$USER" "$PASS"
else
  htpasswd $FLAGS    "$HTPASSWD_FILE" "$USER"
fi

chown root:nginx "$HTPASSWD_FILE" 2>/dev/null || chown root:www-data "$HTPASSWD_FILE" 2>/dev/null || true
chmod 640 "$HTPASSWD_FILE"

echo
echo "✓ Updated $HTPASSWD_FILE"
echo "  Users:"
cut -d: -f1 "$HTPASSWD_FILE" | sed 's/^/    - /'
echo
echo "Reloading nginx…"
nginx -t && systemctl reload nginx
echo "✓ Done. Visit https://nysepicker.duckdns.org/ — browser will prompt for credentials."

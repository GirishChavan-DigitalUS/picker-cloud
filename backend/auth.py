"""
Cookie-based authentication for the Picker dashboard.

Replaces nginx HTTP Basic Auth with a proper login form + HttpOnly signed
session cookie backed by a DB sessions table for server-side revocation.

Session flow
------------
  Login  â†’ verify htpasswd/dev creds â†’ insert `sessions` row â†’ signed cookie
             cookie value = SERIALIZER.dumps({"sid": uuid})
  Requestâ†’ ASGI middleware reads cookie, decodes sid, queries DB
             â†’ if active: stash username in scope["auth_user"]
             â†’ if invalid/expired: return 401
  Logout â†’ deactivate session row â†’ clear cookie

Admin endpoints
---------------
  GET    /api/admin/sessions          â€” list all sessions (active + recent)
  DELETE /api/admin/sessions/{id}     â€” forcibly revoke a session
  GET    /api/admin/login-history     â€” last 50 login attempts

Env vars
--------
  PICKER_AUTH_SECRET       Random >=32 chars (required in prod).
  PICKER_HTPASSWD_PATH     Default: /etc/nginx/.htpasswd-picker
  PICKER_DEV_USER          Dev-only plaintext username fallback.
  PICKER_DEV_PASS          Dev-only plaintext password fallback.
  PICKER_COOKIE_SECURE     Set "0" for plain-HTTP local dev (default "1").
  APPUSER_SESSION_LIMIT    Max concurrent sessions for non-admin accounts
                           (default 5).
"""
from __future__ import annotations

import logging
import os
import re
import secrets
import uuid
from http.cookies import SimpleCookie
from pathlib import Path

import bcrypt
import db as _db
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
COOKIE_NAME           = "picker_session"
COOKIE_MAX_AGE        = 30 * 24 * 3600         # 30 days — keeps iPhone PWA sessions alive across restarts
COOKIE_SECURE         = os.environ.get("PICKER_COOKIE_SECURE", "1") != "0"
COOKIE_SAMESITE       = "strict"               # same-origin PWA; strict is safe and avoids ITP confusion
HTPASSWD_PATH         = os.environ.get("PICKER_HTPASSWD_PATH", "/etc/nginx/.htpasswd-picker")
DEV_USER              = os.environ.get("PICKER_DEV_USER")
DEV_PASS              = os.environ.get("PICKER_DEV_PASS")
APPUSER_SESSION_LIMIT = int(os.environ.get("APPUSER_SESSION_LIMIT", "5"))
LOGIN_RATE_LIMIT      = 5                      # max login attempts per IP per window
LOGIN_RATE_WINDOW     = 300                     # 5-minute sliding window (seconds)

# In-memory rate limiter for login attempts (per IP)
_login_attempts: dict[str, list[float]] = {}
_secret = os.environ.get("PICKER_AUTH_SECRET")
if not _secret:
    _secret = secrets.token_urlsafe(32)
    log.warning(
        "PICKER_AUTH_SECRET not set â€” using an ephemeral secret. "
        "Sessions will be invalidated on every backend restart."
    )
# salt v2 ensures old v1 cookies ({"u":...}) are rejected cleanly.
SERIALIZER = URLSafeTimedSerializer(_secret, salt="picker-session-v2")

PUBLIC_PATHS: set[str] = {
    "/api/health",
    "/api/health/detailed",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/me",
}


# ---------------------------------------------------------------------------
# Credential verification
# ---------------------------------------------------------------------------
def verify_credentials(username: str, password: str) -> bool:
    if not username or not password:
        return False
    # Normalise to lowercase so login is case-insensitive (Admin == admin == ADMIN)
    username = username.strip().lower()
    if DEV_USER and DEV_PASS and username == DEV_USER.lower():
        return secrets.compare_digest(password, DEV_PASS)
    path = Path(HTPASSWD_PATH)
    if not path.is_file():
        log.error("htpasswd file not found at %s", path)
        return False
    try:
        stored_hash: str | None = None
        for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            user, _, hashval = line.partition(":")
            if user.lower() == username:
                stored_hash = hashval.strip()
                break
        if not stored_hash:
            return False
        if stored_hash.startswith("$2y$"):
            stored_hash = "$2b$" + stored_hash[4:]
        if not stored_hash.startswith(("$2a$", "$2b$")):
            log.error("htpasswd entry for %s is not bcrypt; recreate with `htpasswd -B`", username)
            return False
        pw_bytes = password.encode("utf-8")[:72]
        return bcrypt.checkpw(pw_bytes, stored_hash.encode("ascii"))
    except Exception:
        log.exception("htpasswd verification failed for user=%s", username)
        return False


# ---------------------------------------------------------------------------
# User-agent parser â€” compact "Browser / OS" summary
# ---------------------------------------------------------------------------
def _parse_ua(ua: str) -> str:
    if not ua:
        return "Unknown"
    browser = "Other"
    for name, pattern in [
        ("Edge",    r"Edg(?:e)?/(\d+)"),
        ("Chrome",  r"Chrome/(\d+)"),
        ("Firefox", r"Firefox/(\d+)"),
        ("Safari",  r"Version/(\d+).*Safari"),
        ("Opera",   r"OPR/(\d+)"),
    ]:
        m = re.search(pattern, ua)
        if m:
            browser = f"{name} {m.group(1)}"
            break
    os_name = "Other"
    for name, pattern in [
        ("iOS",     r"iPhone|iPad"),
        ("Android", r"Android"),
        ("Windows", r"Windows NT"),
        ("macOS",   r"Mac OS X"),
        ("Linux",   r"Linux"),
    ]:
        if re.search(pattern, ua):
            os_name = name
            break
    return f"{browser} / {os_name}"


# ---------------------------------------------------------------------------
# IP extraction â€” nginx reverse-proxy aware
# ---------------------------------------------------------------------------
def _get_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    return request.client.host if request.client else "unknown"


# ---------------------------------------------------------------------------
# Cookie helpers
# ---------------------------------------------------------------------------
def _issue_cookie(response: Response, session_id: str) -> None:
    token = SERIALIZER.dumps({"sid": session_id})
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        path="/",
    )


def _clear_cookie(response: Response) -> None:
    response.delete_cookie(key=COOKIE_NAME, path="/")


def _session_id_from_token(token: str | None) -> str | None:
    if not token:
        return None
    try:
        data = SERIALIZER.loads(token, max_age=COOKIE_MAX_AGE)
    except (BadSignature, SignatureExpired):
        return None
    if isinstance(data, dict):
        sid = data.get("sid")
        return sid if isinstance(sid, str) else None
    return None


# ---------------------------------------------------------------------------
# ASGI middleware â€” gates /api/* and /ws (HTTP + WebSocket)
# ---------------------------------------------------------------------------
class AuthMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")

        # Always let CORS preflight through unauthenticated.
        if scope["type"] == "http" and scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return

        # Public whitelist â€” auth routes handle their own session lookup
        if path in PUBLIC_PATHS:
            await self.app(scope, receive, send)
            return

        # Only gate API + WebSocket; static / SPA assets are open so the React
        # app can load and render the login form.
        if not (path.startswith("/api/") or path.startswith("/ws")):
            await self.app(scope, receive, send)
            return

        # Extract cookie from raw ASGI headers
        token: str | None = None
        for k, v in scope.get("headers", []):
            if k == b"cookie":
                try:
                    jar: SimpleCookie = SimpleCookie()
                    jar.load(v.decode("latin-1"))
                    morsel = jar.get(COOKIE_NAME)
                    if morsel is not None:
                        token = morsel.value
                except Exception:
                    pass
                break

        sid = _session_id_from_token(token)
        username: str | None = None
        if sid:
            username = await _db.get_session_user(sid)

        if username is None:
            if scope["type"] == "http":
                resp = JSONResponse({"detail": "Authentication required"}, status_code=401)
                await resp(scope, receive, send)
            else:
                await send({"type": "websocket.close", "code": 4401})
            return

        # Stash resolved username in scope for FastAPI dependencies
        scope["auth_user"] = username
        await self.app(scope, receive, send)


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------
def current_user(request: Request) -> str | None:
    return request.scope.get("auth_user")


def require_admin(user: str | None = Depends(current_user)) -> str:
    if user != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


# ---------------------------------------------------------------------------
# Auth router  /api/auth/*
# ---------------------------------------------------------------------------
router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str
    password: str


@router.post("/login")
async def login(body: LoginIn, request: Request, response: Response):
    ip = _get_ip(request)
    ua = request.headers.get("user-agent", "")

    # Rate limit: max LOGIN_RATE_LIMIT attempts per IP within LOGIN_RATE_WINDOW seconds
    import time as _time
    now_ts = _time.monotonic()
    attempts = _login_attempts.get(ip, [])
    attempts = [t for t in attempts if now_ts - t < LOGIN_RATE_WINDOW]
    if len(attempts) >= LOGIN_RATE_LIMIT:
        log.warning("Login rate limit exceeded for IP %s (%d attempts)", ip, len(attempts))
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")
    attempts.append(now_ts)
    _login_attempts[ip] = attempts

    # Normalise username here too so logs and session rows always store lowercase
    normalised_username = body.username.strip().lower()
    ok = verify_credentials(normalised_username, body.password)
    await _db.log_login(normalised_username, ip, ua, ok)
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    # Expire idle sessions before enforcing the per-user concurrency limit.
    await _db.expire_idle_sessions()
    # Non-admin users are limited to APPUSER_SESSION_LIMIT concurrent sessions
    if normalised_username != "admin":
        active = await _db.count_active_sessions(normalised_username)
        if active >= APPUSER_SESSION_LIMIT:
            raise HTTPException(
                status_code=403,
                detail=f"Session limit ({APPUSER_SESSION_LIMIT}) reached for this account. "
                       "Ask an admin to free a session.",
            )
    session_id = str(uuid.uuid4())
    await _db.create_session(session_id, normalised_username, ip, ua)
    _issue_cookie(response, session_id)
    return {"ok": True, "username": normalised_username}


@router.post("/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE_NAME)
    sid = _session_id_from_token(token)
    if sid:
        await _db.deactivate_session(sid)
    _clear_cookie(response)
    return {"ok": True}


@router.get("/me")
async def me(request: Request):
    token = request.cookies.get(COOKIE_NAME)
    sid = _session_id_from_token(token)
    if not sid:
        raise HTTPException(status_code=401, detail="Not authenticated")
    username = await _db.get_session_user(sid)
    if not username:
        raise HTTPException(status_code=401, detail="Session expired or revoked")
    return {"username": username}


# ---------------------------------------------------------------------------
# Admin router  /api/admin/*
# ---------------------------------------------------------------------------
admin_router = APIRouter(prefix="/api/admin", tags=["admin"])


@admin_router.get("/sessions")
async def list_sessions_endpoint(_admin: str = Depends(require_admin)):
    sessions = await _db.list_sessions()
    for s in sessions:
        s["browser_os"] = _parse_ua(s.get("user_agent", ""))
    return {"sessions": sessions}


@admin_router.delete("/sessions/{session_id}")
async def kill_session(session_id: str, _admin: str = Depends(require_admin)):
    await _db.deactivate_session(session_id)
    logger.info("Session %s revoked by admin %s", session_id, _admin)
    return {"ok": True, "deleted_session_id": session_id, "deleted_by": _admin}


@admin_router.get("/login-history")
async def login_history_endpoint(_admin: str = Depends(require_admin)):
    rows = await _db.get_login_history(50)
    for r in rows:
        r["browser_os"] = _parse_ua(r.get("user_agent", ""))
    return {"history": rows}

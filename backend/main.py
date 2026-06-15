"""
FastAPI application entry point.
"""
import logging
import os
from contextlib import asynccontextmanager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import init_db, close_pool
from mcp_client import tv_mcp
from scheduler import start_scheduler, stop_scheduler
from auth import AuthMiddleware, router as auth_router, admin_router
from api.routes_candles import router as candles_router
from api.routes_indicators import router as indicators_router
from api.routes_signals import router as signals_router
from api.routes_predictions import router as predictions_router
from api.routes_composite import router as composite_router
from api.routes_push import router as push_router
from api.routes_costs import router as costs_router
from api.routes_confluence import router as confluence_router
from api.ws import router as ws_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await init_db()
    await tv_mcp.connect()
    await start_scheduler()
    yield
    # Shutdown
    await stop_scheduler()
    await tv_mcp.disconnect()
    await close_pool()


app = FastAPI(title="Picker — NYSE Ticker Dashboard", version="1.0.0", lifespan=lifespan)

_default_origins = ["http://localhost:5173", "http://localhost:4173", "https://nysepicker.duckdns.org"]
_env_origins = os.environ.get("ALLOWED_ORIGINS", "")
_allowed_origins = [o.strip() for o in _env_origins.split(",") if o.strip()] if _env_origins else _default_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cookie-based auth gate — protects /api/* and /ws (except the public
# whitelist defined in auth.PUBLIC_PATHS). Must be added AFTER CORS so the
# CORS preflight (OPTIONS) responses are still emitted correctly.
app.add_middleware(AuthMiddleware)

app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(candles_router, prefix="/api")
app.include_router(indicators_router, prefix="/api")
app.include_router(signals_router, prefix="/api")
app.include_router(predictions_router, prefix="/api")
app.include_router(composite_router, prefix="/api")
app.include_router(push_router, prefix="/api")
app.include_router(costs_router, prefix="/api")
app.include_router(confluence_router, prefix="/api")
app.include_router(ws_router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "data_source": "yfinance"}

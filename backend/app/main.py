"""
MistRoom Relay API — FastAPI Application

This is the optional Internet relay backend for the MistRoom decentralized
mesh messenger. It stores ONLY encrypted data. Private keys, plaintext
messages, and decrypted attachments are NEVER stored or processed.
"""

from __future__ import annotations

import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api.v1 import attachments, devices, envelopes, relays
from app.core.config import settings
from app.core.logging import setup_logging
from app.db.session import engine

# Track startup time for health endpoint
_start_time: float = 0.0


def create_app() -> FastAPI:
    """Application factory."""
    setup_logging()

    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description=(
            "Optional Internet relay for MistRoom mesh messenger. "
            "Stores only encrypted envelopes — never plaintext content."
        ),
        docs_url="/docs" if settings.app_debug else None,
        redoc_url="/redoc" if settings.app_debug else None,
    )

    # ── CORS ──────────────────────────────────────────
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Lifecycle ─────────────────────────────────────
    @app.on_event("startup")
    async def on_startup() -> None:
        global _start_time
        _start_time = time.time()

    @app.on_event("shutdown")
    async def on_shutdown() -> None:
        await engine.dispose()

    # ── Health Endpoints ──────────────────────────────
    @app.get("/health", tags=["health"])
    async def health() -> dict:
        """Basic health check — always returns 200 if the process is alive."""
        return {
            "status": "healthy",
            "version": settings.app_version,
            "uptime_seconds": round(time.time() - _start_time, 2),
        }

    @app.get("/ready", tags=["health"])
    async def ready() -> dict:
        """
        Readiness check — verifies database and (optionally) Redis are reachable.
        Returns 503 if any dependency is down.
        """
        db_status = "unknown"
        redis_status = "disabled"

        # Check MySQL
        try:
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            db_status = "connected"
        except Exception as exc:
            db_status = f"error: {type(exc).__name__}"
            from fastapi.responses import JSONResponse
            return JSONResponse(
                status_code=503,
                content={
                    "status": "not_ready",
                    "database": db_status,
                    "redis": redis_status,
                },
            )

        # Check Redis (best-effort)
        try:
            import redis.asyncio as aioredis
            r = aioredis.from_url(settings.redis_url)
            await r.ping()
            redis_status = "connected"
            await r.aclose()
        except Exception:
            redis_status = "unavailable"

        return {
            "status": "ready",
            "database": db_status,
            "redis": redis_status,
        }

    # ── API Routes ────────────────────────────────────
    app.include_router(devices.router, prefix="/api/v1")
    app.include_router(envelopes.router, prefix="/api/v1")
    app.include_router(attachments.router, prefix="/api/v1")
    app.include_router(relays.router, prefix="/api/v1")

    return app


# Create the application instance
app = create_app()

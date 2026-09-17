"""
Redis-backed sliding-window rate limiter for MistRoom.

Rate limits per API spec:
    - Registration: 5/hour/IP
    - Envelope submission: 100/minute/fingerprint
    - Attachment upload: 20/minute/fingerprint
    - Chunk upload: 200/minute/fingerprint
    - Read operations: 300/minute/fingerprint

Falls back to in-memory counters if Redis is unavailable.
"""

from __future__ import annotations

import time
from collections import defaultdict
from dataclasses import dataclass, field

import structlog
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from app.core.config import settings

logger = structlog.get_logger(__name__)


@dataclass
class RateLimitConfig:
    """Rate limit configuration for a route pattern."""

    max_requests: int
    window_seconds: int
    key_type: str = "fingerprint"  # "fingerprint" or "ip"


# Route pattern → rate limit config
RATE_LIMITS: dict[str, RateLimitConfig] = {
    "POST /api/v1/devices/register": RateLimitConfig(
        max_requests=5, window_seconds=3600, key_type="ip"
    ),
    "POST /api/v1/envelopes": RateLimitConfig(
        max_requests=100, window_seconds=60, key_type="fingerprint"
    ),
    "POST /api/v1/attachments": RateLimitConfig(
        max_requests=20, window_seconds=60, key_type="fingerprint"
    ),
    "POST /api/v1/attachments/*/chunks/*": RateLimitConfig(
        max_requests=200, window_seconds=60, key_type="fingerprint"
    ),
    "GET /api/v1/*": RateLimitConfig(
        max_requests=300, window_seconds=60, key_type="fingerprint"
    ),
}

# Default rate limit for unmatched routes
DEFAULT_LIMIT = RateLimitConfig(max_requests=settings.rate_limit_per_minute, window_seconds=60)


def _match_route(method: str, path: str) -> RateLimitConfig:
    """Match a request to its rate limit config using simple pattern matching."""
    exact_key = f"{method} {path}"

    # Try exact match first
    if exact_key in RATE_LIMITS:
        return RATE_LIMITS[exact_key]

    # Try wildcard patterns
    for pattern, config in RATE_LIMITS.items():
        p_method, p_path = pattern.split(" ", 1)
        if p_method != method:
            continue

        # Simple wildcard matching
        if "*" in p_path:
            pattern_parts = p_path.split("/")
            path_parts = path.split("/")
            if len(pattern_parts) <= len(path_parts):
                match = True
                for pp, rp in zip(pattern_parts, path_parts):
                    if pp != "*" and pp != rp:
                        match = False
                        break
                if match:
                    return config

    return DEFAULT_LIMIT


def _extract_key(request: Request, config: RateLimitConfig) -> str:
    """Extract the rate limit key from the request."""
    if config.key_type == "ip":
        ip = request.client.host if request.client else "unknown"
        return f"ratelimit:ip:{ip}"

    # Try to extract fingerprint from auth header
    auth = request.headers.get("Authorization", "")
    if auth.startswith("MistRoom "):
        parts = auth.split(" ", 1)[1].split(":", 2)
        if len(parts) >= 1 and len(parts[0]) == 32:
            return f"ratelimit:fp:{parts[0]}"

    # Fall back to IP
    ip = request.client.host if request.client else "unknown"
    return f"ratelimit:ip:{ip}"


@dataclass
class InMemoryStore:
    """In-memory fallback rate limit store."""

    # key → list of timestamps
    buckets: dict[str, list[float]] = field(default_factory=lambda: defaultdict(list))

    def check_and_increment(
        self, key: str, max_requests: int, window_seconds: int
    ) -> tuple[bool, int, int]:
        """
        Check rate limit and increment counter.

        Returns:
            (allowed, remaining, reset_seconds)
        """
        now = time.time()
        window_start = now - window_seconds

        # Clean old entries
        self.buckets[key] = [t for t in self.buckets[key] if t > window_start]

        current = len(self.buckets[key])
        remaining = max(0, max_requests - current - 1)
        reset_at = int(window_start + window_seconds)

        if current >= max_requests:
            return False, 0, reset_at

        self.buckets[key].append(now)
        return True, remaining, reset_at


# Global in-memory store (fallback)
_memory_store = InMemoryStore()

# Redis client (initialized lazily; False indicates unavailable)
_redis_client = None


async def _get_redis():
    """Get or create Redis client. Returns None if unavailable."""
    global _redis_client
    if _redis_client is False:
        return None
    if _redis_client is not None:
        return _redis_client

    try:
        import redis.asyncio as aioredis

        client = aioredis.from_url(settings.redis_url, socket_connect_timeout=0.2)
        await client.ping()
        _redis_client = client
        return _redis_client
    except Exception:
        logger.debug("redis_unavailable_using_memory_store")
        _redis_client = False
        return None


async def _check_redis(
    key: str, max_requests: int, window_seconds: int
) -> tuple[bool, int, int]:
    """Check rate limit using Redis sorted set sliding window."""
    redis = await _get_redis()
    if redis is None:
        return _memory_store.check_and_increment(key, max_requests, window_seconds)

    try:
        now = time.time()
        window_start = now - window_seconds

        pipe = redis.pipeline()
        pipe.zremrangebyscore(key, 0, window_start)
        pipe.zcard(key)
        pipe.zadd(key, {str(now): now})
        pipe.expire(key, window_seconds + 1)
        results = await pipe.execute()

        current = results[1]  # zcard result
        remaining = max(0, max_requests - current - 1)
        reset_at = int(window_start + window_seconds)

        if current >= max_requests:
            # Remove the element we just added
            await redis.zrem(key, str(now))
            return False, 0, reset_at

        return True, remaining, reset_at

    except Exception as exc:
        logger.warning("redis_rate_limit_error", error=str(exc))
        return _memory_store.check_and_increment(key, max_requests, window_seconds)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Sliding-window rate limiting middleware."""

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        # Skip rate limiting for health endpoints
        if request.url.path in ("/health", "/ready", "/docs", "/redoc", "/openapi.json"):
            return await call_next(request)

        # Skip WebSocket upgrades (handled separately)
        if request.headers.get("upgrade", "").lower() == "websocket":
            return await call_next(request)

        config = _match_route(request.method, request.url.path)
        key = _extract_key(request, config)

        allowed, remaining, reset_at = await _check_redis(
            key, config.max_requests, config.window_seconds
        )

        if not allowed:
            from fastapi.responses import JSONResponse

            logger.warning(
                "rate_limit_exceeded",
                key=key,
                path=request.url.path,
            )

            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "code": "RATE_LIMIT_EXCEEDED",
                        "message": f"Rate limit exceeded. Try again after {reset_at}",
                    }
                },
                headers={
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": str(reset_at),
                    "Retry-After": str(max(1, reset_at - int(time.time()))),
                },
            )

        response = await call_next(request)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        response.headers["X-RateLimit-Reset"] = str(reset_at)
        return response

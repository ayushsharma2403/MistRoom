"""Tests for rate limiting middleware."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_rate_limit_headers_present(client: AsyncClient) -> None:
    """Rate limit headers are included in responses."""
    response = await client.get("/api/v1/devices/" + "a" * 32)
    # Even if 404, rate limit headers should be present
    assert "X-RateLimit-Remaining" in response.headers
    assert "X-RateLimit-Reset" in response.headers


@pytest.mark.asyncio
async def test_health_not_rate_limited(client: AsyncClient) -> None:
    """Health endpoint is excluded from rate limiting."""
    response = await client.get("/health")
    assert response.status_code == 200
    # Health should NOT have rate limit headers
    assert "X-RateLimit-Remaining" not in response.headers


@pytest.mark.asyncio
async def test_rate_limit_allows_normal_traffic(client: AsyncClient) -> None:
    """Normal traffic below the limit succeeds."""
    # Make several requests (well below any limit)
    for _ in range(5):
        response = await client.get("/api/v1/devices/" + "c" * 32)
        # Should get 404 (device not found) but not 429
        assert response.status_code != 429

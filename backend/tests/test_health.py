"""Tests for health and readiness endpoints."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_endpoint(client: AsyncClient) -> None:
    """Health endpoint returns 200 with status, version, and uptime."""
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert "version" in data
    assert "uptime_seconds" in data
    assert isinstance(data["uptime_seconds"], (int, float))


@pytest.mark.asyncio
async def test_health_returns_version(client: AsyncClient) -> None:
    """Health endpoint returns the configured app version."""
    response = await client.get("/health")
    data = response.json()
    assert data["version"] == "0.1.0"


@pytest.mark.asyncio
async def test_openapi_docs_available(client: AsyncClient) -> None:
    """OpenAPI docs endpoint is available in debug mode."""
    response = await client.get("/docs")
    # In debug mode, should return the Swagger UI (200)
    assert response.status_code == 200

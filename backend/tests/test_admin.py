"""Tests for admin endpoints."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from tests.conftest import DeviceIdentity, register_device


@pytest.mark.asyncio
async def test_admin_stats_requires_key(client: AsyncClient) -> None:
    """Admin stats without API key returns 403."""
    response = await client.get("/api/v1/admin/stats")
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_admin_stats_with_key(
    client: AsyncClient, admin_headers: dict[str, str]
) -> None:
    """Admin stats with valid key returns server stats."""
    response = await client.get("/api/v1/admin/stats", headers=admin_headers)
    assert response.status_code == 200
    data = response.json()
    assert "devices" in data
    assert "envelopes" in data
    assert "websocket" in data
    assert "server" in data


@pytest.mark.asyncio
async def test_admin_block_device(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    admin_headers: dict[str, str],
) -> None:
    """Admin can block a registered device."""
    await register_device(client, device_identity)

    response = await client.delete(
        f"/api/v1/admin/devices/{device_identity.fingerprint}?reason=Testing",
        headers=admin_headers,
    )
    assert response.status_code == 200
    assert response.json()["status"] == "blocked"


@pytest.mark.asyncio
async def test_admin_block_nonexistent_device(
    client: AsyncClient, admin_headers: dict[str, str]
) -> None:
    """Blocking a non-existent device returns 404."""
    response = await client.delete(
        "/api/v1/admin/devices/" + "f" * 32,
        headers=admin_headers,
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_admin_unblock_device(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    admin_headers: dict[str, str],
) -> None:
    """Admin can unblock a blocked device."""
    await register_device(client, device_identity)

    # Block
    await client.delete(
        f"/api/v1/admin/devices/{device_identity.fingerprint}",
        headers=admin_headers,
    )

    # Unblock
    response = await client.post(
        f"/api/v1/admin/devices/{device_identity.fingerprint}/unblock",
        headers=admin_headers,
    )
    assert response.status_code == 200
    assert response.json()["status"] == "unblocked"


@pytest.mark.asyncio
async def test_admin_audit_log(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    admin_headers: dict[str, str],
) -> None:
    """Admin can query audit log."""
    await register_device(client, device_identity)

    response = await client.get(
        "/api/v1/admin/audit-log",
        headers=admin_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert "events" in data
    assert isinstance(data["events"], list)


@pytest.mark.asyncio
async def test_admin_audit_log_filter_by_type(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    admin_headers: dict[str, str],
) -> None:
    """Admin can filter audit log by event type."""
    await register_device(client, device_identity)

    response = await client.get(
        "/api/v1/admin/audit-log?event_type=DEVICE_REGISTERED",
        headers=admin_headers,
    )
    assert response.status_code == 200
    data = response.json()
    for event in data["events"]:
        assert event["event_type"] == "DEVICE_REGISTERED"


@pytest.mark.asyncio
async def test_admin_invalid_key(client: AsyncClient) -> None:
    """Admin endpoint with wrong key returns 403."""
    response = await client.get(
        "/api/v1/admin/stats",
        headers={"X-Admin-Key": "wrong_key_here"},
    )
    assert response.status_code == 403

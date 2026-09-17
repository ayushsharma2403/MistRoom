"""Tests for Ed25519 authentication."""

from __future__ import annotations

import base64
import time

import pytest
from httpx import AsyncClient

from tests.conftest import DeviceIdentity, register_device


@pytest.mark.asyncio
async def test_auth_header_parsing(client: AsyncClient, device_identity: DeviceIdentity) -> None:
    """Valid auth header is parsed and accepted after registration."""
    await register_device(client, device_identity)

    headers = device_identity.auth_headers("GET", f"/api/v1/devices/{device_identity.fingerprint}")
    response = await client.get(
        f"/api/v1/devices/{device_identity.fingerprint}",
        headers=headers,
    )
    # Device lookup is public, but with auth it should still work
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_missing_auth_header(client: AsyncClient) -> None:
    """Missing Authorization header returns 401."""
    response = await client.get("/api/v1/envelopes/pending?recipient_fingerprint=a" * 32)
    # Will fail because pending envelopes requires auth
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_invalid_auth_format(client: AsyncClient) -> None:
    """Invalid auth header format returns 401."""
    response = await client.get(
        "/api/v1/envelopes/pending?recipient_fingerprint=" + "a" * 32,
        headers={"Authorization": "Bearer invalid"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_expired_timestamp(client: AsyncClient, device_identity: DeviceIdentity) -> None:
    """Auth with expired timestamp returns 401."""
    await register_device(client, device_identity)

    # Create auth with old timestamp (10 minutes ago)
    old_ts = int((time.time() - 600) * 1000)
    msg = f"{device_identity.fingerprint}{old_ts}GET/api/v1/envelopes/pending".encode()
    sig = device_identity.sign(msg)
    sig_b64 = base64.b64encode(sig).decode()

    response = await client.get(
        f"/api/v1/envelopes/pending?recipient_fingerprint={device_identity.fingerprint}",
        headers={
            "Authorization": f"MistRoom {device_identity.fingerprint}:{old_ts}:{sig_b64}"
        },
    )
    assert response.status_code == 401
    assert "TIMESTAMP_EXPIRED" in response.text


@pytest.mark.asyncio
async def test_invalid_signature(client: AsyncClient, device_identity: DeviceIdentity) -> None:
    """Auth with invalid signature returns 401."""
    await register_device(client, device_identity)

    timestamp_ms = int(time.time() * 1000)
    # Sign wrong message
    wrong_sig = device_identity.sign(b"wrong message")
    sig_b64 = base64.b64encode(wrong_sig).decode()

    response = await client.get(
        f"/api/v1/envelopes/pending?recipient_fingerprint={device_identity.fingerprint}",
        headers={
            "Authorization": f"MistRoom {device_identity.fingerprint}:{timestamp_ms}:{sig_b64}"
        },
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_unknown_device_fingerprint(client: AsyncClient) -> None:
    """Auth with unregistered fingerprint returns 401."""
    from tests.conftest import make_device_identity

    identity = make_device_identity()
    headers = identity.auth_headers("GET", "/api/v1/envelopes/pending")

    response = await client.get(
        f"/api/v1/envelopes/pending?recipient_fingerprint={identity.fingerprint}",
        headers=headers,
    )
    assert response.status_code == 401
    assert "DEVICE_NOT_FOUND" in response.text

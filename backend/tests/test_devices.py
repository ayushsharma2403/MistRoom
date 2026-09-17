"""Tests for device registration, lookup, and key rotation."""

from __future__ import annotations

import base64
import hashlib
import time

import pytest
from httpx import AsyncClient
from nacl.signing import SigningKey

from tests.conftest import DeviceIdentity, register_device


@pytest.mark.asyncio
async def test_register_device_success(client: AsyncClient, device_identity: DeviceIdentity) -> None:
    """Device registration succeeds with valid keys."""
    response_data = await register_device(client, device_identity)
    assert "device_id" in response_data
    assert response_data["fingerprint"] == device_identity.fingerprint


@pytest.mark.asyncio
async def test_register_duplicate_fingerprint(
    client: AsyncClient, device_identity: DeviceIdentity
) -> None:
    """Registering the same fingerprint twice returns 409."""
    await register_device(client, device_identity)

    timestamp_ms = int(time.time() * 1000)
    sig = device_identity.sign(f"{device_identity.fingerprint}{timestamp_ms}".encode())

    response = await client.post(
        "/api/v1/devices/register",
        json={
            "fingerprint": device_identity.fingerprint,
            "ed25519_public_key": device_identity.ed25519_public_b64,
            "x25519_public_key": device_identity.x25519_public_b64,
            "protocol_version": 1,
            "capabilities": 0,
            "timestamp": timestamp_ms,
            "signature": base64.b64encode(sig).decode(),
        },
    )
    assert response.status_code == 409
    assert "DEVICE_EXISTS" in response.text


@pytest.mark.asyncio
async def test_register_invalid_key_length(client: AsyncClient) -> None:
    """Registration with wrong-length keys returns 422."""
    signing_key = SigningKey.generate()
    ed_pub = bytes(signing_key.verify_key)
    fingerprint = hashlib.sha256(ed_pub).hexdigest()[:32]
    timestamp_ms = int(time.time() * 1000)
    sig = signing_key.sign(f"{fingerprint}{timestamp_ms}".encode()).signature

    response = await client.post(
        "/api/v1/devices/register",
        json={
            "fingerprint": fingerprint,
            "ed25519_public_key": base64.b64encode(ed_pub).decode(),
            "x25519_public_key": base64.b64encode(b"short").decode(),  # Wrong length
            "protocol_version": 1,
            "capabilities": 0,
            "timestamp": timestamp_ms,
            "signature": base64.b64encode(sig).decode(),
        },
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_register_fingerprint_mismatch(client: AsyncClient) -> None:
    """Registration with mismatched fingerprint returns 422."""
    signing_key = SigningKey.generate()
    ed_pub = bytes(signing_key.verify_key)
    import os

    x_pub = os.urandom(32)
    wrong_fp = "a" * 32  # Wrong fingerprint
    timestamp_ms = int(time.time() * 1000)
    sig = signing_key.sign(f"{wrong_fp}{timestamp_ms}".encode()).signature

    response = await client.post(
        "/api/v1/devices/register",
        json={
            "fingerprint": wrong_fp,
            "ed25519_public_key": base64.b64encode(ed_pub).decode(),
            "x25519_public_key": base64.b64encode(x_pub).decode(),
            "protocol_version": 1,
            "capabilities": 0,
            "timestamp": timestamp_ms,
            "signature": base64.b64encode(sig).decode(),
        },
    )
    assert response.status_code == 422
    assert "FINGERPRINT_MISMATCH" in response.text


@pytest.mark.asyncio
async def test_get_device_success(client: AsyncClient, device_identity: DeviceIdentity) -> None:
    """Looking up a registered device returns its public info."""
    await register_device(client, device_identity)

    response = await client.get(f"/api/v1/devices/{device_identity.fingerprint}")
    assert response.status_code == 200
    data = response.json()
    assert data["fingerprint"] == device_identity.fingerprint
    assert data["ed25519_public_key"] == device_identity.ed25519_public_b64
    assert data["protocol_version"] == 1


@pytest.mark.asyncio
async def test_get_device_not_found(client: AsyncClient) -> None:
    """Looking up a non-existent device returns 404."""
    response = await client.get("/api/v1/devices/" + "b" * 32)
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_key_rotation_requires_auth(client: AsyncClient) -> None:
    """Key rotation without auth returns 401."""
    import os

    response = await client.post(
        "/api/v1/devices/rotate-key",
        json={
            "new_x25519_public_key": base64.b64encode(os.urandom(32)).decode(),
            "old_key_signature": base64.b64encode(os.urandom(64)).decode(),
            "timestamp": int(time.time() * 1000),
            "signature": base64.b64encode(os.urandom(64)).decode(),
        },
    )
    assert response.status_code == 401

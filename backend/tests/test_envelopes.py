"""Tests for encrypted envelope endpoints."""

from __future__ import annotations

import base64
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from tests.conftest import DeviceIdentity, register_device


@pytest.mark.asyncio
async def test_submit_envelope_authenticated(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
) -> None:
    """Authenticated envelope submission succeeds."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    envelope_id = str(uuid.uuid4())
    expires_at = (datetime.now(UTC) + timedelta(days=7)).isoformat()

    headers = device_identity.auth_headers("POST", "/api/v1/envelopes")
    payload = base64.b64encode(b"encrypted_data_here").decode()
    sig = base64.b64encode(device_identity.sign(b"envelope_signature")).decode()

    response = await client.post(
        "/api/v1/envelopes",
        json={
            "envelope_id": envelope_id,
            "sender_fingerprint": device_identity.fingerprint,
            "recipient_fingerprint": second_device_identity.fingerprint,
            "encrypted_payload": payload,
            "priority": "HIGH",
            "expires_at": expires_at,
            "signature": sig,
        },
        headers=headers,
    )
    assert response.status_code == 201
    data = response.json()
    assert data["envelope_id"] == envelope_id


@pytest.mark.asyncio
async def test_submit_envelope_unauthenticated(client: AsyncClient) -> None:
    """Envelope submission without auth returns 401."""
    envelope_id = str(uuid.uuid4())
    expires_at = (datetime.now(UTC) + timedelta(days=7)).isoformat()

    response = await client.post(
        "/api/v1/envelopes",
        json={
            "envelope_id": envelope_id,
            "sender_fingerprint": "a" * 32,
            "recipient_fingerprint": "b" * 32,
            "encrypted_payload": base64.b64encode(b"test").decode(),
            "priority": "MEDIUM",
            "expires_at": expires_at,
            "signature": base64.b64encode(b"x" * 64).decode(),
        },
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_submit_envelope_fingerprint_mismatch(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
) -> None:
    """Envelope submission with wrong sender_fingerprint returns 403."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    envelope_id = str(uuid.uuid4())
    expires_at = (datetime.now(UTC) + timedelta(days=7)).isoformat()

    # Auth as device_identity but claim sender is second_device
    headers = device_identity.auth_headers("POST", "/api/v1/envelopes")

    response = await client.post(
        "/api/v1/envelopes",
        json={
            "envelope_id": envelope_id,
            "sender_fingerprint": second_device_identity.fingerprint,  # Mismatch!
            "recipient_fingerprint": device_identity.fingerprint,
            "encrypted_payload": base64.b64encode(b"test").decode(),
            "priority": "MEDIUM",
            "expires_at": expires_at,
            "signature": base64.b64encode(b"x" * 64).decode(),
        },
        headers=headers,
    )
    assert response.status_code == 403
    assert "FINGERPRINT_MISMATCH" in response.text


@pytest.mark.asyncio
async def test_get_pending_envelopes(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
) -> None:
    """Pending envelopes returns envelopes for the authenticated device."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    # Submit an envelope from device_identity to second_device
    envelope_id = str(uuid.uuid4())
    expires_at = (datetime.now(UTC) + timedelta(days=7)).isoformat()
    headers = device_identity.auth_headers("POST", "/api/v1/envelopes")

    await client.post(
        "/api/v1/envelopes",
        json={
            "envelope_id": envelope_id,
            "sender_fingerprint": device_identity.fingerprint,
            "recipient_fingerprint": second_device_identity.fingerprint,
            "encrypted_payload": base64.b64encode(b"hello_encrypted").decode(),
            "priority": "MEDIUM",
            "expires_at": expires_at,
            "signature": base64.b64encode(device_identity.sign(b"sig")).decode(),
        },
        headers=headers,
    )

    # Retrieve pending as second_device
    recv_headers = second_device_identity.auth_headers("GET", "/api/v1/envelopes/pending")
    response = await client.get(
        f"/api/v1/envelopes/pending?recipient_fingerprint={second_device_identity.fingerprint}",
        headers=recv_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["envelopes"]) >= 1
    assert data["envelopes"][0]["envelope_id"] == envelope_id


@pytest.mark.asyncio
async def test_get_pending_wrong_fingerprint(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
) -> None:
    """Cannot retrieve another device's pending envelopes."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    # Auth as device_identity but request second_device's envelopes
    headers = device_identity.auth_headers("GET", "/api/v1/envelopes/pending")
    response = await client.get(
        f"/api/v1/envelopes/pending?recipient_fingerprint={second_device_identity.fingerprint}",
        headers=headers,
    )
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_acknowledge_envelope(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
) -> None:
    """Recipient can acknowledge an envelope."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    # Submit envelope
    envelope_id = str(uuid.uuid4())
    expires_at = (datetime.now(UTC) + timedelta(days=7)).isoformat()
    send_headers = device_identity.auth_headers("POST", "/api/v1/envelopes")
    await client.post(
        "/api/v1/envelopes",
        json={
            "envelope_id": envelope_id,
            "sender_fingerprint": device_identity.fingerprint,
            "recipient_fingerprint": second_device_identity.fingerprint,
            "encrypted_payload": base64.b64encode(b"msg").decode(),
            "priority": "MEDIUM",
            "expires_at": expires_at,
            "signature": base64.b64encode(device_identity.sign(b"s")).decode(),
        },
        headers=send_headers,
    )

    # Acknowledge as recipient
    recv_headers = second_device_identity.auth_headers(
        "POST", f"/api/v1/envelopes/{envelope_id}/receipt"
    )
    response = await client.post(
        f"/api/v1/envelopes/{envelope_id}/receipt",
        json={
            "received_at": datetime.now(UTC).isoformat(),
            "signature": base64.b64encode(second_device_identity.sign(b"ack")).decode(),
        },
        headers=recv_headers,
    )
    assert response.status_code == 200
    assert response.json()["status"] == "acknowledged"

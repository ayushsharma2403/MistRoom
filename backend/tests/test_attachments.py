"""Tests for attachment chunked upload endpoints."""

from __future__ import annotations

import base64
import hashlib
import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from tests.conftest import DeviceIdentity, register_device


@pytest.mark.asyncio
async def test_create_attachment_success(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
) -> None:
    """Attachment creation succeeds with valid auth and data."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    headers = device_identity.auth_headers("POST", "/api/v1/attachments")
    attachment_id = str(uuid.uuid4())
    encrypted_meta = base64.b64encode(b"encrypted_filename_and_mime").decode()
    sig = base64.b64encode(device_identity.sign(b"attachment_sig")).decode()
    expires_at = (datetime.now(UTC) + timedelta(days=30)).isoformat()

    response = await client.post(
        "/api/v1/attachments",
        json={
            "attachment_id": attachment_id,
            "sender_fingerprint": device_identity.fingerprint,
            "recipient_fingerprint": second_device_identity.fingerprint,
            "encrypted_metadata": encrypted_meta,
            "total_size": 1024,
            "chunk_count": 2,
            "chunk_size": 512,
            "file_hash": hashlib.sha256(b"test_file").hexdigest(),
            "expires_at": expires_at,
            "signature": sig,
        },
        headers=headers,
    )
    assert response.status_code == 201
    data = response.json()
    assert data["attachment_id"] == attachment_id
    assert "upload_url_prefix" in data


@pytest.mark.asyncio
async def test_create_attachment_unauthenticated(client: AsyncClient) -> None:
    """Attachment creation without auth returns 401."""
    response = await client.post(
        "/api/v1/attachments",
        json={
            "attachment_id": str(uuid.uuid4()),
            "sender_fingerprint": "a" * 32,
            "recipient_fingerprint": "b" * 32,
            "encrypted_metadata": base64.b64encode(b"x").decode(),
            "total_size": 100,
            "chunk_count": 1,
            "chunk_size": 100,
            "file_hash": "a" * 64,
            "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
            "signature": base64.b64encode(b"x" * 64).decode(),
        },
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_create_attachment_fingerprint_mismatch(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
) -> None:
    """Attachment creation with wrong sender fingerprint returns 403."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    headers = device_identity.auth_headers("POST", "/api/v1/attachments")
    response = await client.post(
        "/api/v1/attachments",
        json={
            "attachment_id": str(uuid.uuid4()),
            "sender_fingerprint": second_device_identity.fingerprint,  # Mismatch
            "recipient_fingerprint": device_identity.fingerprint,
            "encrypted_metadata": base64.b64encode(b"x").decode(),
            "total_size": 100,
            "chunk_count": 1,
            "chunk_size": 100,
            "file_hash": "a" * 64,
            "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
            "signature": base64.b64encode(b"x" * 64).decode(),
        },
        headers=headers,
    )
    assert response.status_code == 403
    assert "FINGERPRINT_MISMATCH" in response.text


@pytest.mark.asyncio
async def test_create_attachment_too_large(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
) -> None:
    """Attachment exceeding max size returns 413."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    headers = device_identity.auth_headers("POST", "/api/v1/attachments")
    response = await client.post(
        "/api/v1/attachments",
        json={
            "attachment_id": str(uuid.uuid4()),
            "sender_fingerprint": device_identity.fingerprint,
            "recipient_fingerprint": second_device_identity.fingerprint,
            "encrypted_metadata": base64.b64encode(b"x").decode(),
            "total_size": 999_999_999_999,  # Way too large
            "chunk_count": 1,
            "chunk_size": 100,
            "file_hash": "a" * 64,
            "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
            "signature": base64.b64encode(b"x" * 64).decode(),
        },
        headers=headers,
    )
    assert response.status_code == 413


@pytest.mark.asyncio
async def test_upload_chunk_and_complete(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
    tmp_path,
) -> None:
    """Full flow: create attachment, upload chunks, complete."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    # Patch chunk storage dir to tmp
    import app.api.v1.attachments as att_mod

    original_dir = att_mod.CHUNK_STORAGE_DIR
    att_mod.CHUNK_STORAGE_DIR = str(tmp_path)

    try:
        attachment_id = str(uuid.uuid4())
        chunk_data_0 = os.urandom(256)
        chunk_data_1 = os.urandom(256)
        all_data = chunk_data_0 + chunk_data_1
        file_hash = hashlib.sha256(all_data).hexdigest()

        # Create attachment
        headers = device_identity.auth_headers("POST", "/api/v1/attachments")
        create_resp = await client.post(
            "/api/v1/attachments",
            json={
                "attachment_id": attachment_id,
                "sender_fingerprint": device_identity.fingerprint,
                "recipient_fingerprint": second_device_identity.fingerprint,
                "encrypted_metadata": base64.b64encode(b"meta").decode(),
                "total_size": 512,
                "chunk_count": 2,
                "chunk_size": 256,
                "file_hash": file_hash,
                "expires_at": (datetime.now(UTC) + timedelta(days=30)).isoformat(),
                "signature": base64.b64encode(device_identity.sign(b"s")).decode(),
            },
            headers=headers,
        )
        assert create_resp.status_code == 201

        # Upload chunk 0
        chunk0_hash = hashlib.sha256(chunk_data_0).hexdigest()
        headers0 = device_identity.auth_headers(
            "POST", f"/api/v1/attachments/{attachment_id}/chunks/0"
        )
        headers0["X-Chunk-Hash"] = chunk0_hash
        headers0["Content-Type"] = "application/octet-stream"
        resp0 = await client.post(
            f"/api/v1/attachments/{attachment_id}/chunks/0",
            content=chunk_data_0,
            headers=headers0,
        )
        assert resp0.status_code == 201
        assert resp0.json()["chunk_index"] == 0
        assert resp0.json()["verified"] is True

        # Upload chunk 1
        chunk1_hash = hashlib.sha256(chunk_data_1).hexdigest()
        headers1 = device_identity.auth_headers(
            "POST", f"/api/v1/attachments/{attachment_id}/chunks/1"
        )
        headers1["X-Chunk-Hash"] = chunk1_hash
        headers1["Content-Type"] = "application/octet-stream"
        resp1 = await client.post(
            f"/api/v1/attachments/{attachment_id}/chunks/1",
            content=chunk_data_1,
            headers=headers1,
        )
        assert resp1.status_code == 201

        # Check missing chunks (should be empty)
        missing_headers = device_identity.auth_headers(
            "GET", f"/api/v1/attachments/{attachment_id}/missing-chunks"
        )
        missing_resp = await client.get(
            f"/api/v1/attachments/{attachment_id}/missing-chunks",
            headers=missing_headers,
        )
        assert missing_resp.status_code == 200
        assert missing_resp.json()["missing_indices"] == []

        # Complete
        complete_headers = device_identity.auth_headers(
            "POST", f"/api/v1/attachments/{attachment_id}/complete"
        )
        complete_resp = await client.post(
            f"/api/v1/attachments/{attachment_id}/complete",
            json={
                "final_hash": file_hash,
                "signature": base64.b64encode(device_identity.sign(b"done")).decode(),
            },
            headers=complete_headers,
        )
        assert complete_resp.status_code == 200
        assert complete_resp.json()["status"] == "COMPLETE"
        assert complete_resp.json()["verified"] is True

    finally:
        att_mod.CHUNK_STORAGE_DIR = original_dir


@pytest.mark.asyncio
async def test_upload_duplicate_chunk_rejected(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
    tmp_path,
) -> None:
    """Uploading the same chunk index twice returns 409."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    import app.api.v1.attachments as att_mod

    original_dir = att_mod.CHUNK_STORAGE_DIR
    att_mod.CHUNK_STORAGE_DIR = str(tmp_path)

    try:
        attachment_id = str(uuid.uuid4())
        headers = device_identity.auth_headers("POST", "/api/v1/attachments")
        await client.post(
            "/api/v1/attachments",
            json={
                "attachment_id": attachment_id,
                "sender_fingerprint": device_identity.fingerprint,
                "recipient_fingerprint": second_device_identity.fingerprint,
                "encrypted_metadata": base64.b64encode(b"m").decode(),
                "total_size": 256,
                "chunk_count": 1,
                "chunk_size": 256,
                "file_hash": "a" * 64,
                "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
                "signature": base64.b64encode(device_identity.sign(b"s")).decode(),
            },
            headers=headers,
        )

        chunk = os.urandom(256)
        h = device_identity.auth_headers(
            "POST", f"/api/v1/attachments/{attachment_id}/chunks/0"
        )
        h["Content-Type"] = "application/octet-stream"
        await client.post(
            f"/api/v1/attachments/{attachment_id}/chunks/0",
            content=chunk,
            headers=h,
        )

        # Second upload of same chunk
        h2 = device_identity.auth_headers(
            "POST", f"/api/v1/attachments/{attachment_id}/chunks/0"
        )
        h2["Content-Type"] = "application/octet-stream"
        resp = await client.post(
            f"/api/v1/attachments/{attachment_id}/chunks/0",
            content=chunk,
            headers=h2,
        )
        assert resp.status_code == 409
        assert "CHUNK_EXISTS" in resp.text

    finally:
        att_mod.CHUNK_STORAGE_DIR = original_dir


@pytest.mark.asyncio
async def test_missing_chunks_endpoint(
    client: AsyncClient,
    device_identity: DeviceIdentity,
    second_device_identity: DeviceIdentity,
    tmp_path,
) -> None:
    """Missing chunks endpoint returns correct indices."""
    await register_device(client, device_identity)
    await register_device(client, second_device_identity)

    import app.api.v1.attachments as att_mod

    original_dir = att_mod.CHUNK_STORAGE_DIR
    att_mod.CHUNK_STORAGE_DIR = str(tmp_path)

    try:
        attachment_id = str(uuid.uuid4())
        headers = device_identity.auth_headers("POST", "/api/v1/attachments")
        await client.post(
            "/api/v1/attachments",
            json={
                "attachment_id": attachment_id,
                "sender_fingerprint": device_identity.fingerprint,
                "recipient_fingerprint": second_device_identity.fingerprint,
                "encrypted_metadata": base64.b64encode(b"m").decode(),
                "total_size": 768,
                "chunk_count": 3,
                "chunk_size": 256,
                "file_hash": "b" * 64,
                "expires_at": (datetime.now(UTC) + timedelta(days=1)).isoformat(),
                "signature": base64.b64encode(device_identity.sign(b"s")).decode(),
            },
            headers=headers,
        )

        # Upload only chunk 1 (skip 0 and 2)
        chunk = os.urandom(256)
        h = device_identity.auth_headers(
            "POST", f"/api/v1/attachments/{attachment_id}/chunks/1"
        )
        h["Content-Type"] = "application/octet-stream"
        await client.post(
            f"/api/v1/attachments/{attachment_id}/chunks/1",
            content=chunk,
            headers=h,
        )

        # Check missing
        mh = device_identity.auth_headers(
            "GET", f"/api/v1/attachments/{attachment_id}/missing-chunks"
        )
        resp = await client.get(
            f"/api/v1/attachments/{attachment_id}/missing-chunks",
            headers=mh,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["received_chunks"] == 1
        assert 0 in data["missing_indices"]
        assert 2 in data["missing_indices"]
        assert 1 not in data["missing_indices"]

    finally:
        att_mod.CHUNK_STORAGE_DIR = original_dir

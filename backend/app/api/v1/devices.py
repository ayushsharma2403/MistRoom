"""Device registration and public-key directory endpoints."""

from __future__ import annotations

import base64
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.models import Device, DevicePublicKey
from app.schemas.schemas import (
    DevicePublicInfo,
    DeviceRegisterRequest,
    DeviceRegisterResponse,
    ErrorResponse,
    KeyRotateRequest,
    KeyRotateResponse,
)

router = APIRouter(prefix="/devices", tags=["devices"])


@router.post(
    "/register",
    response_model=DeviceRegisterResponse,
    status_code=status.HTTP_201_CREATED,
    responses={409: {"model": ErrorResponse}},
)
async def register_device(
    req: DeviceRegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> DeviceRegisterResponse:
    """
    Register a new device with the relay.
    Stores ONLY public keys — never private keys.
    """
    # Check for existing device
    existing = await db.execute(
        select(Device).where(Device.fingerprint == req.fingerprint)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "DEVICE_EXISTS", "message": "Device fingerprint already registered"},
        )

    # Decode and validate public keys
    try:
        ed25519_bytes = base64.b64decode(req.ed25519_public_key)
        x25519_bytes = base64.b64decode(req.x25519_public_key)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_KEY", "message": f"Invalid base64 key: {exc}"},
        ) from exc

    if len(ed25519_bytes) != 32 or len(x25519_bytes) != 32:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_KEY_LENGTH", "message": "Keys must be 32 bytes"},
        )

    # Decode optional encrypted display name
    display_name_enc = None
    if req.display_name_encrypted:
        try:
            display_name_enc = base64.b64decode(req.display_name_encrypted)
        except Exception:
            pass  # Non-critical; store None

    # Create device record
    device = Device(
        fingerprint=req.fingerprint,
        display_name_encrypted=display_name_enc,
        protocol_version=req.protocol_version,
        capabilities=req.capabilities,
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(device)
    await db.flush()  # Get device.id

    # Store public keys
    ed_key = DevicePublicKey(
        device_id=device.id,
        key_type="ed25519",
        public_key=ed25519_bytes,
    )
    x_key = DevicePublicKey(
        device_id=device.id,
        key_type="x25519",
        public_key=x25519_bytes,
    )
    db.add_all([ed_key, x_key])

    return DeviceRegisterResponse(
        device_id=device.id,
        fingerprint=device.fingerprint,
        registered_at=device.registered_at or datetime.now(timezone.utc),
    )


@router.get(
    "/{fingerprint}",
    response_model=DevicePublicInfo,
    responses={404: {"model": ErrorResponse}},
)
async def get_device(
    fingerprint: str,
    db: AsyncSession = Depends(get_db),
) -> DevicePublicInfo:
    """Retrieve a device's public keys and capabilities."""
    result = await db.execute(
        select(Device).where(Device.fingerprint == fingerprint.lower())
    )
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "DEVICE_NOT_FOUND", "message": "Unknown device fingerprint"},
        )

    # Load active public keys
    keys_result = await db.execute(
        select(DevicePublicKey).where(
            DevicePublicKey.device_id == device.id,
            DevicePublicKey.is_active.is_(True),
        )
    )
    keys = keys_result.scalars().all()

    ed_key = next((k for k in keys if k.key_type == "ed25519"), None)
    x_key = next((k for k in keys if k.key_type == "x25519"), None)

    return DevicePublicInfo(
        fingerprint=device.fingerprint,
        ed25519_public_key=base64.b64encode(ed_key.public_key).decode() if ed_key else "",
        x25519_public_key=base64.b64encode(x_key.public_key).decode() if x_key else "",
        protocol_version=device.protocol_version,
        capabilities=device.capabilities,
        last_seen=device.last_seen_at,
    )


@router.post(
    "/rotate-key",
    response_model=KeyRotateResponse,
)
async def rotate_key(
    req: KeyRotateRequest,
    db: AsyncSession = Depends(get_db),
) -> KeyRotateResponse:
    """
    Rotate X25519 key pair. Deactivates old key, stores new one.
    TODO: Add proper Ed25519 signature verification in Phase 1.
    """
    # Placeholder: In production, verify req.signature against device's Ed25519 key
    # For now, return a structured response indicating the endpoint exists
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail={
            "code": "NOT_IMPLEMENTED",
            "message": "Key rotation requires Ed25519 signature verification (Phase 1)",
        },
    )

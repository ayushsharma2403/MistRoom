"""Device registration, public-key directory, and key rotation endpoints."""

from __future__ import annotations

import base64
from datetime import UTC, datetime

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.core.audit import EVENT_DEVICE_REGISTERED, EVENT_KEY_ROTATED, log_audit_event
from app.core.auth import get_authenticated_device, verify_ed25519_signature
from app.models.models import Device, DevicePublicKey
from app.schemas.schemas import (
    DevicePublicInfo,
    DeviceRegisterRequest,
    DeviceRegisterResponse,
    ErrorResponse,
    KeyRotateRequest,
    KeyRotateResponse,
)

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/devices", tags=["devices"])


@router.post(
    "/register",
    response_model=DeviceRegisterResponse,
    status_code=status.HTTP_201_CREATED,
    responses={409: {"model": ErrorResponse}},
)
async def register_device(
    req: DeviceRegisterRequest,
    request: Request,
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

    # Verify that the fingerprint matches the Ed25519 public key
    import hashlib

    expected_fp = hashlib.sha256(ed25519_bytes).hexdigest()[:32]
    if req.fingerprint != expected_fp:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "code": "FINGERPRINT_MISMATCH",
                "message": "Fingerprint does not match SHA-256(ed25519_public_key)[0:16]",
            },
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
        last_seen_at=datetime.now(UTC),
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

    # Audit event
    await log_audit_event(
        db,
        EVENT_DEVICE_REGISTERED,
        device_fingerprint=req.fingerprint,
        ip_address=request.client.host if request.client else None,
        details={"protocol_version": req.protocol_version},
    )

    return DeviceRegisterResponse(
        device_id=device.id,
        fingerprint=device.fingerprint,
        registered_at=device.registered_at or datetime.now(UTC),
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
    device: Device = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
) -> KeyRotateResponse:
    """
    Rotate X25519 key pair.
    Requires Ed25519 authentication.
    Deactivates old X25519 key and stores the new one.
    """
    # Decode new X25519 public key
    try:
        new_x25519_bytes = base64.b64decode(req.new_x25519_public_key)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_KEY", "message": f"Invalid base64 key: {exc}"},
        ) from exc

    if len(new_x25519_bytes) != 32:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_KEY_LENGTH", "message": "X25519 key must be 32 bytes"},
        )

    # Get and deactivate old X25519 key
    old_key_result = await db.execute(
        select(DevicePublicKey).where(
            DevicePublicKey.device_id == device.id,
            DevicePublicKey.key_type == "x25519",
            DevicePublicKey.is_active.is_(True),
        )
    )
    old_key = old_key_result.scalar_one_or_none()

    if old_key:
        # Verify the old_key_signature signs the old public key
        ed_key_result = await db.execute(
            select(DevicePublicKey).where(
                DevicePublicKey.device_id == device.id,
                DevicePublicKey.key_type == "ed25519",
                DevicePublicKey.is_active.is_(True),
            )
        )
        ed_key = ed_key_result.scalar_one_or_none()
        if ed_key:
            try:
                old_sig_bytes = base64.b64decode(req.old_key_signature)
                if not verify_ed25519_signature(
                    ed_key.public_key, old_key.public_key, old_sig_bytes
                ):
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail={
                            "code": "INVALID_OLD_KEY_SIGNATURE",
                            "message": "Signature over old key is invalid",
                        },
                    )
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={"code": "INVALID_SIGNATURE", "message": "Invalid old_key_signature"},
                )

        old_key.is_active = False
        old_key.revoked_at = datetime.now(UTC)

    # Store new X25519 key
    new_key = DevicePublicKey(
        device_id=device.id,
        key_type="x25519",
        public_key=new_x25519_bytes,
    )
    db.add(new_key)

    now = datetime.now(UTC)

    # Audit
    await log_audit_event(
        db,
        EVENT_KEY_ROTATED,
        device_fingerprint=device.fingerprint,
    )

    return KeyRotateResponse(
        fingerprint=device.fingerprint,
        key_rotated_at=now,
    )

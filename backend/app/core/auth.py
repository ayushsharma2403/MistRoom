"""
Ed25519 device authentication for MistRoom.

Protocol:
    Authorization: MistRoom <fingerprint>:<timestamp_ms>:<base64_signature>
    signature = Ed25519_sign(private_key, fingerprint || timestamp || method || path)
    Timestamp must be within ±5 minutes (300 000 ms).
"""

from __future__ import annotations

import base64
import hashlib
import time
from datetime import UTC

import structlog
from fastapi import Depends, HTTPException, Request, status
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.models import BlockedDevice, Device, DevicePublicKey

logger = structlog.get_logger(__name__)

# Maximum clock drift in milliseconds (±5 minutes)
MAX_TIMESTAMP_DRIFT_MS = 300_000


class AuthError(HTTPException):
    """Authentication-specific HTTP exception."""

    def __init__(self, message: str, code: str = "AUTH_FAILED") -> None:
        super().__init__(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": code, "message": message},
            headers={"WWW-Authenticate": "MistRoom"},
        )


def verify_ed25519_signature(
    public_key_bytes: bytes,
    message: bytes,
    signature: bytes,
) -> bool:
    """
    Verify an Ed25519 signature using PyNaCl.

    Returns True if valid, raises AuthError if invalid.
    """
    if len(public_key_bytes) != 32:
        raise AuthError("Invalid public key length", code="INVALID_KEY")
    if len(signature) != 64:
        raise AuthError("Invalid signature length", code="INVALID_SIGNATURE")

    try:
        verify_key = VerifyKey(public_key_bytes)
        verify_key.verify(message, signature)
        return True
    except BadSignatureError:
        return False
    except Exception as exc:
        logger.warning("signature_verification_error", error=str(exc))
        return False


def parse_auth_header(authorization: str) -> tuple[str, int, bytes]:
    """
    Parse the MistRoom authorization header.

    Format: MistRoom <fingerprint>:<timestamp_ms>:<base64_signature>

    Returns:
        (fingerprint, timestamp_ms, signature_bytes)
    """
    if not authorization:
        raise AuthError("Missing Authorization header", code="MISSING_AUTH")

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0] != "MistRoom":
        raise AuthError(
            "Invalid Authorization header format. Expected: MistRoom <fingerprint>:<timestamp>:<signature>",
            code="INVALID_AUTH_FORMAT",
        )

    token_parts = parts[1].split(":", 2)
    if len(token_parts) != 3:
        raise AuthError(
            "Invalid token format. Expected: <fingerprint>:<timestamp>:<signature>",
            code="INVALID_TOKEN_FORMAT",
        )

    fingerprint, timestamp_str, sig_b64 = token_parts

    # Validate fingerprint format
    if len(fingerprint) != 32:
        raise AuthError("Invalid fingerprint length", code="INVALID_FINGERPRINT")
    try:
        bytes.fromhex(fingerprint)
    except ValueError:
        raise AuthError("Fingerprint must be hex", code="INVALID_FINGERPRINT")

    # Parse timestamp
    try:
        timestamp_ms = int(timestamp_str)
    except ValueError:
        raise AuthError("Invalid timestamp", code="INVALID_TIMESTAMP")

    # Decode signature
    try:
        signature = base64.b64decode(sig_b64)
    except Exception:
        raise AuthError("Invalid base64 signature", code="INVALID_SIGNATURE")

    return fingerprint.lower(), timestamp_ms, signature


def check_timestamp_drift(timestamp_ms: int) -> None:
    """Reject requests with timestamps outside ±5 minutes."""
    now_ms = int(time.time() * 1000)
    drift = abs(now_ms - timestamp_ms)
    if drift > MAX_TIMESTAMP_DRIFT_MS:
        raise AuthError(
            f"Timestamp drift too large: {drift}ms (max {MAX_TIMESTAMP_DRIFT_MS}ms)",
            code="TIMESTAMP_EXPIRED",
        )


def build_auth_message(
    fingerprint: str,
    timestamp_ms: int,
    method: str,
    path: str,
) -> bytes:
    """Build the message that should have been signed by the client."""
    return f"{fingerprint}{timestamp_ms}{method.upper()}{path}".encode()


def hash_ip(ip: str | None) -> str | None:
    """SHA-256 hash an IP address for audit logging. Never store raw IPs."""
    if not ip:
        return None
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()


async def get_authenticated_device(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Device:
    """
    FastAPI dependency: authenticate request via Ed25519 signature.

    Extracts the Authorization header, looks up the device by fingerprint,
    retrieves the active Ed25519 public key, and verifies the signature.
    """
    authorization = request.headers.get("Authorization", "")
    fingerprint, timestamp_ms, signature = parse_auth_header(authorization)

    # Check timestamp freshness
    check_timestamp_drift(timestamp_ms)

    # Check if device is blocked
    blocked = await db.execute(
        select(BlockedDevice).where(BlockedDevice.device_fingerprint == fingerprint)
    )
    if blocked.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "DEVICE_BLOCKED", "message": "Device has been blocked"},
        )

    # Look up device
    result = await db.execute(
        select(Device).where(Device.fingerprint == fingerprint)
    )
    device = result.scalar_one_or_none()
    if not device:
        raise AuthError("Unknown device fingerprint", code="DEVICE_NOT_FOUND")

    # Get active Ed25519 public key
    key_result = await db.execute(
        select(DevicePublicKey).where(
            DevicePublicKey.device_id == device.id,
            DevicePublicKey.key_type == "ed25519",
            DevicePublicKey.is_active.is_(True),
        )
    )
    ed_key = key_result.scalar_one_or_none()
    if not ed_key:
        raise AuthError("No active Ed25519 key found for device", code="NO_KEY")

    # Build the expected signed message
    message = build_auth_message(
        fingerprint, timestamp_ms, request.method, request.url.path
    )

    # Verify signature
    if not verify_ed25519_signature(ed_key.public_key, message, signature):
        logger.warning(
            "auth_signature_invalid",
            fingerprint=fingerprint,
            ip_hash=hash_ip(request.client.host if request.client else None),
        )
        raise AuthError("Invalid signature", code="INVALID_SIGNATURE")

    # Update last_seen
    from datetime import datetime

    device.last_seen_at = datetime.now(UTC)

    logger.debug("device_authenticated", fingerprint=fingerprint)
    return device


async def get_optional_auth(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Device | None:
    """
    Optional authentication dependency.
    Returns Device if auth header is present and valid, None otherwise.
    """
    authorization = request.headers.get("Authorization", "")
    if not authorization or not authorization.startswith("MistRoom "):
        return None

    try:
        return await get_authenticated_device(request, db)
    except HTTPException:
        return None

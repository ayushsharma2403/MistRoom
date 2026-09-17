"""
Audit event logging for MistRoom.

Records security-relevant events with hashed identifiers.
Never stores raw IP addresses or plaintext content.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import AuditEvent

logger = structlog.get_logger(__name__)

# Standard event types
EVENT_DEVICE_REGISTERED = "DEVICE_REGISTERED"
EVENT_KEY_ROTATED = "KEY_ROTATED"
EVENT_ENVELOPE_SUBMITTED = "ENVELOPE_SUBMITTED"
EVENT_ENVELOPE_DELIVERED = "ENVELOPE_DELIVERED"
EVENT_RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED"
EVENT_AUTH_FAILED = "AUTH_FAILED"
EVENT_DEVICE_BLOCKED = "DEVICE_BLOCKED"
EVENT_DEVICE_UNBLOCKED = "DEVICE_UNBLOCKED"
EVENT_ATTACHMENT_CREATED = "ATTACHMENT_CREATED"
EVENT_ATTACHMENT_COMPLETED = "ATTACHMENT_COMPLETED"
EVENT_RELAY_REGISTERED = "RELAY_REGISTERED"
EVENT_WS_CONNECTED = "WS_CONNECTED"
EVENT_WS_DISCONNECTED = "WS_DISCONNECTED"


def hash_ip(ip: str | None) -> str | None:
    """SHA-256 hash of IP address. Never store raw IPs."""
    if not ip:
        return None
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()


async def log_audit_event(
    db: AsyncSession,
    event_type: str,
    *,
    device_fingerprint: str | None = None,
    ip_address: str | None = None,
    details: dict[str, Any] | None = None,
) -> AuditEvent:
    """
    Create an audit event record.

    Args:
        db: Database session.
        event_type: One of the EVENT_* constants.
        device_fingerprint: Optional device fingerprint.
        ip_address: Raw IP — will be hashed before storage.
        details: Optional non-sensitive metadata (JSON-serializable).
    """
    event = AuditEvent(
        event_type=event_type,
        device_fingerprint=device_fingerprint,
        ip_hash=hash_ip(ip_address),
        details=json.dumps(details) if details else None,
    )
    db.add(event)

    logger.info(
        "audit_event",
        event_type=event_type,
        fingerprint=device_fingerprint,
    )

    return event

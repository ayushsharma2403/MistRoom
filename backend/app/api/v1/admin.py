"""Admin endpoints for MistRoom relay server management."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.core.audit import (
    EVENT_DEVICE_BLOCKED,
    EVENT_DEVICE_UNBLOCKED,
    log_audit_event,
)
from app.core.config import settings
from app.models.models import (
    AuditEvent,
    BlockedDevice,
    Device,
    MessageEnvelope,
)

router = APIRouter(prefix="/admin", tags=["admin"])


async def _require_admin(request: Request) -> None:
    """Verify admin API key from X-Admin-Key header."""
    api_key = request.headers.get("X-Admin-Key", "")
    if not api_key or api_key != settings.admin_api_key:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "ADMIN_REQUIRED", "message": "Valid admin API key required"},
        )


@router.get("/stats")
async def get_stats(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Server statistics overview."""
    await _require_admin(request)

    # Count devices
    device_count = await db.scalar(select(func.count()).select_from(Device))

    # Count blocked devices
    blocked_count = await db.scalar(select(func.count()).select_from(BlockedDevice))

    # Count pending envelopes
    pending_count = await db.scalar(
        select(func.count())
        .select_from(MessageEnvelope)
        .where(
            MessageEnvelope.is_delivered.is_(False),
            MessageEnvelope.expires_at > datetime.now(UTC),
        )
    )

    # Count delivered envelopes
    delivered_count = await db.scalar(
        select(func.count())
        .select_from(MessageEnvelope)
        .where(MessageEnvelope.is_delivered.is_(True))
    )

    # Active WebSocket connections
    from app.api.v1.websocket import manager

    ws_connections = manager.active_count

    return {
        "devices": {
            "total": device_count or 0,
            "blocked": blocked_count or 0,
        },
        "envelopes": {
            "pending": pending_count or 0,
            "delivered": delivered_count or 0,
        },
        "websocket": {
            "active_connections": ws_connections,
        },
        "server": {
            "version": settings.app_version,
            "environment": settings.app_env,
        },
    }


@router.delete("/devices/{fingerprint}")
async def block_device(
    fingerprint: str,
    request: Request,
    reason: str = Query(default="Admin action"),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Block a device from using the relay."""
    await _require_admin(request)

    # Check if already blocked
    existing = await db.execute(
        select(BlockedDevice).where(BlockedDevice.device_fingerprint == fingerprint.lower())
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ALREADY_BLOCKED", "message": "Device is already blocked"},
        )

    # Check device exists
    device_result = await db.execute(
        select(Device).where(Device.fingerprint == fingerprint.lower())
    )
    device = device_result.scalar_one_or_none()
    if not device:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "DEVICE_NOT_FOUND", "message": "Unknown device fingerprint"},
        )

    # Block device
    device.is_blocked = True
    block_record = BlockedDevice(
        device_fingerprint=fingerprint.lower(),
        reason=reason,
        blocked_by="admin",
    )
    db.add(block_record)

    # Audit
    await log_audit_event(
        db,
        EVENT_DEVICE_BLOCKED,
        device_fingerprint=fingerprint.lower(),
        details={"reason": reason},
    )

    # Disconnect WebSocket if active
    from app.api.v1.websocket import manager

    if manager.is_online(fingerprint.lower()):
        await manager.disconnect(fingerprint.lower())

    return {"status": "blocked", "fingerprint": fingerprint.lower()}


@router.post("/devices/{fingerprint}/unblock")
async def unblock_device(
    fingerprint: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Unblock a previously blocked device."""
    await _require_admin(request)

    result = await db.execute(
        select(BlockedDevice).where(BlockedDevice.device_fingerprint == fingerprint.lower())
    )
    block_record = result.scalar_one_or_none()
    if not block_record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_BLOCKED", "message": "Device is not blocked"},
        )

    await db.delete(block_record)

    # Unblock on device record
    device_result = await db.execute(
        select(Device).where(Device.fingerprint == fingerprint.lower())
    )
    device = device_result.scalar_one_or_none()
    if device:
        device.is_blocked = False

    await log_audit_event(
        db,
        EVENT_DEVICE_UNBLOCKED,
        device_fingerprint=fingerprint.lower(),
    )

    return {"status": "unblocked", "fingerprint": fingerprint.lower()}


@router.get("/audit-log")
async def get_audit_log(
    request: Request,
    event_type: str | None = Query(default=None),
    fingerprint: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Query audit events with optional filtering."""
    await _require_admin(request)

    query = select(AuditEvent).order_by(AuditEvent.created_at.desc())

    if event_type:
        query = query.where(AuditEvent.event_type == event_type)
    if fingerprint:
        query = query.where(AuditEvent.device_fingerprint == fingerprint.lower())

    query = query.offset(offset).limit(limit + 1)
    result = await db.execute(query)
    events = list(result.scalars().all())

    has_more = len(events) > limit
    if has_more:
        events = events[:limit]

    return {
        "events": [
            {
                "id": e.id,
                "event_type": e.event_type,
                "device_fingerprint": e.device_fingerprint,
                "ip_hash": e.ip_hash,
                "details": e.details,
                "created_at": e.created_at.isoformat() if e.created_at else None,
            }
            for e in events
        ],
        "has_more": has_more,
        "limit": limit,
        "offset": offset,
    }

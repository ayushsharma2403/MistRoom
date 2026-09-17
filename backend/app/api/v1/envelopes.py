"""Encrypted message envelope relay endpoints."""

from __future__ import annotations

import base64
from datetime import UTC, datetime

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.core.audit import (
    EVENT_ENVELOPE_DELIVERED,
    EVENT_ENVELOPE_SUBMITTED,
    log_audit_event,
)
from app.core.auth import get_authenticated_device
from app.core.config import settings
from app.models.models import DeliveryReceipt, Device, MessageEnvelope
from app.schemas.schemas import (
    EnvelopeReceiptRequest,
    EnvelopeResponse,
    EnvelopeSubmitRequest,
    EnvelopeSubmitResponse,
    ErrorResponse,
    PendingEnvelopesResponse,
)

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/envelopes", tags=["envelopes"])


@router.post(
    "",
    response_model=EnvelopeSubmitResponse,
    status_code=status.HTTP_201_CREATED,
    responses={413: {"model": ErrorResponse}},
)
async def submit_envelope(
    req: EnvelopeSubmitRequest,
    request: Request,
    device: Device = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
) -> EnvelopeSubmitResponse:
    """
    Submit an encrypted envelope for relay delivery.
    The server stores ONLY ciphertext — it cannot decrypt the content.
    """
    # Verify sender_fingerprint matches authenticated device
    if req.sender_fingerprint.lower() != device.fingerprint.lower():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "FINGERPRINT_MISMATCH",
                "message": "sender_fingerprint does not match authenticated device",
            },
        )

    # Decode and validate payload size
    try:
        payload_bytes = base64.b64decode(req.encrypted_payload)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_PAYLOAD", "message": f"Invalid base64 payload: {exc}"},
        ) from exc

    if len(payload_bytes) > settings.max_envelope_size_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "code": "PAYLOAD_TOO_LARGE",
                "message": f"Max envelope size is {settings.max_envelope_size_bytes} bytes",
            },
        )

    try:
        sig_bytes = base64.b64decode(req.signature)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_SIGNATURE", "message": f"Invalid base64 signature: {exc}"},
        ) from exc

    envelope = MessageEnvelope(
        id=req.envelope_id,
        sender_fingerprint=req.sender_fingerprint,
        recipient_fingerprint=req.recipient_fingerprint,
        encrypted_payload=payload_bytes,
        priority=req.priority.value,
        signature=sig_bytes,
        expires_at=req.expires_at,
    )
    db.add(envelope)

    # Try real-time WebSocket delivery
    from app.api.v1.websocket import manager

    if manager.is_online(req.recipient_fingerprint):
        forwarded = await manager.send_to(
            req.recipient_fingerprint,
            {
                "type": "ENVELOPE",
                "data": {
                    "envelope_id": req.envelope_id,
                    "sender_fingerprint": req.sender_fingerprint,
                    "encrypted_payload": req.encrypted_payload,
                    "signature": req.signature,
                    "priority": req.priority.value,
                },
            },
        )
        if forwarded:
            envelope.is_delivered = True
            envelope.delivered_at = datetime.now(UTC)

    # Audit
    await log_audit_event(
        db,
        EVENT_ENVELOPE_SUBMITTED,
        device_fingerprint=device.fingerprint,
        ip_address=request.client.host if request.client else None,
        details={"recipient": req.recipient_fingerprint, "priority": req.priority.value},
    )

    now = datetime.now(UTC)
    return EnvelopeSubmitResponse(
        envelope_id=envelope.id,
        queued_at=now,
        expires_at=envelope.expires_at,
    )


@router.get(
    "/pending",
    response_model=PendingEnvelopesResponse,
)
async def get_pending_envelopes(
    recipient_fingerprint: str = Query(..., min_length=32, max_length=32),
    limit: int = Query(default=50, ge=1, le=200),
    after: str | None = Query(default=None),
    device: Device = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
) -> PendingEnvelopesResponse:
    """
    Retrieve pending encrypted envelopes for the authenticated device.
    Only returns envelopes addressed to the authenticated device's fingerprint.
    """
    # Verify the requesting device matches the recipient
    if recipient_fingerprint.lower() != device.fingerprint.lower():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "FINGERPRINT_MISMATCH",
                "message": "Can only retrieve envelopes for your own fingerprint",
            },
        )

    query = (
        select(MessageEnvelope)
        .where(
            MessageEnvelope.recipient_fingerprint == recipient_fingerprint.lower(),
            MessageEnvelope.is_delivered.is_(False),
            MessageEnvelope.expires_at > datetime.now(UTC),
        )
        .order_by(MessageEnvelope.created_at.asc())
        .limit(limit + 1)  # Fetch one extra to check has_more
    )

    if after:
        query = query.where(MessageEnvelope.id > after)

    result = await db.execute(query)
    envelopes = list(result.scalars().all())

    has_more = len(envelopes) > limit
    if has_more:
        envelopes = envelopes[:limit]

    return PendingEnvelopesResponse(
        envelopes=[
            EnvelopeResponse(
                envelope_id=e.id,
                sender_fingerprint=e.sender_fingerprint,
                encrypted_payload=base64.b64encode(e.encrypted_payload).decode(),
                queued_at=e.created_at,
                expires_at=e.expires_at,
                priority=e.priority,
                signature=base64.b64encode(e.signature).decode(),
            )
            for e in envelopes
        ],
        has_more=has_more,
        cursor=envelopes[-1].id if envelopes else None,
    )


@router.post(
    "/{envelope_id}/receipt",
    status_code=status.HTTP_200_OK,
)
async def acknowledge_envelope(
    envelope_id: str,
    req: EnvelopeReceiptRequest,
    request: Request,
    device: Device = Depends(get_authenticated_device),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Mark an envelope as delivered."""
    result = await db.execute(
        select(MessageEnvelope).where(MessageEnvelope.id == envelope_id)
    )
    envelope = result.scalar_one_or_none()
    if not envelope:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "ENVELOPE_NOT_FOUND", "message": "No envelope with the specified ID"},
        )

    # Only the recipient can acknowledge
    if envelope.recipient_fingerprint.lower() != device.fingerprint.lower():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "NOT_RECIPIENT", "message": "Only the recipient can acknowledge"},
        )

    envelope.is_delivered = True
    envelope.delivered_at = req.received_at

    receipt = DeliveryReceipt(
        envelope_id=envelope_id,
        device_fingerprint=device.fingerprint,
        receipt_type="DELIVERED",
    )
    db.add(receipt)

    # Audit
    await log_audit_event(
        db,
        EVENT_ENVELOPE_DELIVERED,
        device_fingerprint=device.fingerprint,
        details={"envelope_id": envelope_id},
    )

    return {"status": "acknowledged", "envelope_id": envelope_id}

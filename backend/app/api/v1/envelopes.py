"""Encrypted message envelope relay endpoints."""

from __future__ import annotations

import base64
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.core.config import settings
from app.models.models import DeliveryReceipt, MessageEnvelope
from app.schemas.schemas import (
    EnvelopeReceiptRequest,
    EnvelopeResponse,
    EnvelopeSubmitRequest,
    EnvelopeSubmitResponse,
    ErrorResponse,
    PendingEnvelopesResponse,
)

router = APIRouter(prefix="/envelopes", tags=["envelopes"])


@router.post(
    "",
    response_model=EnvelopeSubmitResponse,
    status_code=status.HTTP_201_CREATED,
    responses={413: {"model": ErrorResponse}},
)
async def submit_envelope(
    req: EnvelopeSubmitRequest,
    db: AsyncSession = Depends(get_db),
) -> EnvelopeSubmitResponse:
    """
    Submit an encrypted envelope for relay delivery.
    The server stores ONLY ciphertext — it cannot decrypt the content.
    """
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

    now = datetime.now(timezone.utc)
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
    db: AsyncSession = Depends(get_db),
) -> PendingEnvelopesResponse:
    """
    Retrieve pending encrypted envelopes for a device.
    TODO: Add proper authentication in Phase 1 — currently trusts fingerprint param.
    """
    query = (
        select(MessageEnvelope)
        .where(
            MessageEnvelope.recipient_fingerprint == recipient_fingerprint.lower(),
            MessageEnvelope.is_delivered.is_(False),
            MessageEnvelope.expires_at > datetime.now(timezone.utc),
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

    envelope.is_delivered = True
    envelope.delivered_at = req.received_at

    receipt = DeliveryReceipt(
        envelope_id=envelope_id,
        device_fingerprint=envelope.recipient_fingerprint,
        receipt_type="DELIVERED",
    )
    db.add(receipt)

    return {"status": "acknowledged", "envelope_id": envelope_id}

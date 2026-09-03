"""Relay registry endpoints."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.models.models import RelayEndpoint
from app.schemas.schemas import (
    RelayListResponse,
    RelayRegisterRequest,
    RelayResponse,
)

router = APIRouter(prefix="/relays", tags=["relays"])


@router.post(
    "/register",
    status_code=status.HTTP_201_CREATED,
)
async def register_relay(
    req: RelayRegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Register a Nostr or WebSocket relay endpoint."""
    # Check for duplicate
    existing = await db.execute(
        select(RelayEndpoint).where(RelayEndpoint.relay_url == req.relay_url)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "RELAY_EXISTS", "message": "Relay URL already registered"},
        )

    relay = RelayEndpoint(
        relay_url=req.relay_url,
        relay_type=req.relay_type.value,
        capabilities=json.dumps(req.capabilities) if req.capabilities else None,
        max_event_size=req.max_event_size,
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(relay)

    return {"relay_id": relay.id, "status": "registered"}


@router.get(
    "",
    response_model=RelayListResponse,
)
async def list_relays(
    relay_type: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> RelayListResponse:
    """List known relay endpoints."""
    query = select(RelayEndpoint).where(RelayEndpoint.status == "ACTIVE")

    if relay_type:
        query = query.where(RelayEndpoint.relay_type == relay_type.upper())

    query = query.order_by(RelayEndpoint.created_at.desc()).offset(offset).limit(limit)
    result = await db.execute(query)
    relays = result.scalars().all()

    return RelayListResponse(
        relays=[
            RelayResponse(
                relay_id=r.id,
                relay_url=r.relay_url,
                relay_type=r.relay_type,
                last_seen=r.last_seen_at,
                status=r.status,
            )
            for r in relays
        ]
    )

"""Attachment chunked upload coordination endpoints."""

from __future__ import annotations

import base64
import hashlib
import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.core.config import settings
from app.models.models import AttachmentChunk, AttachmentMetadata
from app.schemas.schemas import (
    AttachmentCompleteRequest,
    AttachmentCompleteResponse,
    AttachmentCreateRequest,
    AttachmentCreateResponse,
    AttachmentStatus,
    ChunkUploadResponse,
    ErrorResponse,
    MissingChunksResponse,
)

router = APIRouter(prefix="/attachments", tags=["attachments"])

# Storage directory for encrypted chunks
CHUNK_STORAGE_DIR = os.environ.get("CHUNK_STORAGE_DIR", "/app/storage/chunks")


@router.post(
    "",
    response_model=AttachmentCreateResponse,
    status_code=status.HTTP_201_CREATED,
    responses={413: {"model": ErrorResponse}},
)
async def create_attachment(
    req: AttachmentCreateRequest,
    db: AsyncSession = Depends(get_db),
) -> AttachmentCreateResponse:
    """Create an attachment transfer session for chunked upload."""
    if req.total_size > settings.max_attachment_size_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "code": "ATTACHMENT_TOO_LARGE",
                "message": f"Max attachment size is {settings.max_attachment_size_bytes} bytes",
            },
        )

    try:
        metadata_bytes = base64.b64decode(req.encrypted_metadata)
        sig_bytes = base64.b64decode(req.signature)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "INVALID_BASE64", "message": str(exc)},
        ) from exc

    attachment = AttachmentMetadata(
        id=req.attachment_id,
        sender_fingerprint=req.sender_fingerprint,
        recipient_fingerprint=req.recipient_fingerprint,
        encrypted_metadata=metadata_bytes,
        total_size=req.total_size,
        chunk_count=req.chunk_count,
        chunk_size=req.chunk_size,
        file_hash=req.file_hash,
        signature=sig_bytes,
        expires_at=req.expires_at,
    )
    db.add(attachment)

    return AttachmentCreateResponse(
        attachment_id=attachment.id,
        upload_url_prefix=f"/api/v1/attachments/{attachment.id}/chunks/",
        created_at=datetime.now(timezone.utc),
    )


@router.post(
    "/{attachment_id}/chunks/{chunk_index}",
    response_model=ChunkUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_chunk(
    attachment_id: str,
    chunk_index: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> ChunkUploadResponse:
    """Upload a single encrypted chunk."""
    # Validate attachment exists
    result = await db.execute(
        select(AttachmentMetadata).where(AttachmentMetadata.id == attachment_id)
    )
    attachment = result.scalar_one_or_none()
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    if chunk_index < 0 or chunk_index >= attachment.chunk_count:
        raise HTTPException(status_code=400, detail="Invalid chunk index")

    # Check for duplicate
    existing = await db.execute(
        select(AttachmentChunk).where(
            AttachmentChunk.attachment_id == attachment_id,
            AttachmentChunk.chunk_index == chunk_index,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "CHUNK_EXISTS", "message": "Chunk already uploaded"},
        )

    # Read chunk body
    body = await request.body()
    if len(body) > settings.max_chunk_size_bytes:
        raise HTTPException(status_code=413, detail="Chunk too large")

    # Verify chunk hash
    chunk_hash = hashlib.sha256(body).hexdigest()
    expected_hash = request.headers.get("X-Chunk-Hash", "")
    if expected_hash and chunk_hash != expected_hash.lower():
        raise HTTPException(
            status_code=400,
            detail={"code": "HASH_MISMATCH", "message": "Chunk hash does not match"},
        )

    # Store encrypted chunk to disk
    os.makedirs(os.path.join(CHUNK_STORAGE_DIR, attachment_id), exist_ok=True)
    chunk_path = os.path.join(CHUNK_STORAGE_DIR, attachment_id, f"{chunk_index:06d}.bin")
    with open(chunk_path, "wb") as f:
        f.write(body)

    # Record in database
    chunk_record = AttachmentChunk(
        attachment_id=attachment_id,
        chunk_index=chunk_index,
        chunk_hash=chunk_hash,
        size=len(body),
        storage_path=chunk_path,
    )
    db.add(chunk_record)

    # Update completed count
    attachment.completed_chunks += 1

    return ChunkUploadResponse(
        chunk_index=chunk_index,
        received_hash=chunk_hash,
        verified=True,
    )


@router.get(
    "/{attachment_id}/missing-chunks",
    response_model=MissingChunksResponse,
)
async def get_missing_chunks(
    attachment_id: str,
    db: AsyncSession = Depends(get_db),
) -> MissingChunksResponse:
    """Get list of chunks not yet uploaded (for resume)."""
    result = await db.execute(
        select(AttachmentMetadata).where(AttachmentMetadata.id == attachment_id)
    )
    attachment = result.scalar_one_or_none()
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    chunks_result = await db.execute(
        select(AttachmentChunk.chunk_index).where(
            AttachmentChunk.attachment_id == attachment_id
        )
    )
    received = {row[0] for row in chunks_result.all()}
    all_indices = set(range(attachment.chunk_count))
    missing = sorted(all_indices - received)

    return MissingChunksResponse(
        attachment_id=attachment_id,
        total_chunks=attachment.chunk_count,
        received_chunks=len(received),
        missing_indices=missing,
    )


@router.post(
    "/{attachment_id}/complete",
    response_model=AttachmentCompleteResponse,
)
async def complete_attachment(
    attachment_id: str,
    req: AttachmentCompleteRequest,
    db: AsyncSession = Depends(get_db),
) -> AttachmentCompleteResponse:
    """Signal that all chunks are uploaded; verify completeness."""
    result = await db.execute(
        select(AttachmentMetadata).where(AttachmentMetadata.id == attachment_id)
    )
    attachment = result.scalar_one_or_none()
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    # Check all chunks are present
    if attachment.completed_chunks < attachment.chunk_count:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "INCOMPLETE",
                "message": f"Only {attachment.completed_chunks}/{attachment.chunk_count} chunks received",
            },
        )

    # Verify file hash matches
    verified = req.final_hash.lower() == attachment.file_hash.lower()
    attachment.status = "COMPLETE" if verified else "UPLOADING"

    return AttachmentCompleteResponse(
        attachment_id=attachment_id,
        status=AttachmentStatus.COMPLETE if verified else AttachmentStatus.UPLOADING,
        verified=verified,
    )

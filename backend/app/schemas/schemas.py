"""Pydantic request/response schemas for the API."""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator


# ── Enums ─────────────────────────────────────────────────────────────


class Priority(str, Enum):
    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"
    BULK = "BULK"


class ReceiptType(str, Enum):
    DELIVERED = "DELIVERED"
    READ = "READ"
    FAILED = "FAILED"


class AttachmentStatus(str, Enum):
    UPLOADING = "UPLOADING"
    COMPLETE = "COMPLETE"
    EXPIRED = "EXPIRED"
    CANCELLED = "CANCELLED"


class RelayType(str, Enum):
    NOSTR = "NOSTR"
    WEBSOCKET = "WEBSOCKET"


# ── Device Schemas ────────────────────────────────────────────────────


class DeviceRegisterRequest(BaseModel):
    fingerprint: str = Field(
        ..., min_length=32, max_length=32,
        description="SHA-256(Ed25519 public key)[0:16] as hex",
    )
    ed25519_public_key: str = Field(
        ..., description="Base64-encoded Ed25519 public key (32 bytes)"
    )
    x25519_public_key: str = Field(
        ..., description="Base64-encoded X25519 public key (32 bytes)"
    )
    display_name_encrypted: str | None = Field(
        None, description="Base64-encoded encrypted display name"
    )
    protocol_version: int = Field(default=1, ge=1, le=255)
    capabilities: int = Field(default=0, ge=0)
    timestamp: int = Field(..., description="Unix timestamp milliseconds")
    signature: str = Field(..., description="Base64-encoded Ed25519 signature")

    @field_validator("fingerprint")
    @classmethod
    def validate_hex(cls, v: str) -> str:
        try:
            bytes.fromhex(v)
        except ValueError as exc:
            raise ValueError("fingerprint must be a valid hex string") from exc
        return v.lower()


class DeviceRegisterResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    device_id: str
    fingerprint: str
    registered_at: datetime


class DevicePublicInfo(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    fingerprint: str
    ed25519_public_key: str
    x25519_public_key: str
    protocol_version: int
    capabilities: int
    last_seen: datetime | None = None


class KeyRotateRequest(BaseModel):
    new_x25519_public_key: str
    old_key_signature: str
    timestamp: int
    signature: str


class KeyRotateResponse(BaseModel):
    fingerprint: str
    key_rotated_at: datetime


# ── Envelope Schemas ──────────────────────────────────────────────────


class EnvelopeSubmitRequest(BaseModel):
    envelope_id: str = Field(..., min_length=36, max_length=36)
    sender_fingerprint: str = Field(..., min_length=32, max_length=32)
    recipient_fingerprint: str = Field(..., min_length=32, max_length=32)
    encrypted_payload: str = Field(..., description="Base64-encoded ciphertext")
    priority: Priority = Priority.MEDIUM
    expires_at: datetime
    signature: str = Field(..., description="Base64-encoded Ed25519 signature")


class EnvelopeSubmitResponse(BaseModel):
    envelope_id: str
    queued_at: datetime
    expires_at: datetime


class EnvelopeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    envelope_id: str
    sender_fingerprint: str
    encrypted_payload: str
    queued_at: datetime
    expires_at: datetime
    priority: Priority
    signature: str


class PendingEnvelopesResponse(BaseModel):
    envelopes: list[EnvelopeResponse]
    has_more: bool
    cursor: str | None = None


class EnvelopeReceiptRequest(BaseModel):
    received_at: datetime
    signature: str


# ── Attachment Schemas ────────────────────────────────────────────────


class AttachmentCreateRequest(BaseModel):
    attachment_id: str = Field(..., min_length=36, max_length=36)
    sender_fingerprint: str = Field(..., min_length=32, max_length=32)
    recipient_fingerprint: str = Field(..., min_length=32, max_length=32)
    encrypted_metadata: str = Field(..., description="Base64-encoded encrypted metadata")
    total_size: int = Field(..., gt=0)
    chunk_count: int = Field(..., gt=0, le=100000)
    chunk_size: int = Field(..., gt=0)
    file_hash: str = Field(..., min_length=64, max_length=64, description="SHA-256 hex")
    expires_at: datetime
    signature: str


class AttachmentCreateResponse(BaseModel):
    attachment_id: str
    upload_url_prefix: str
    created_at: datetime


class ChunkUploadResponse(BaseModel):
    chunk_index: int
    received_hash: str
    verified: bool


class MissingChunksResponse(BaseModel):
    attachment_id: str
    total_chunks: int
    received_chunks: int
    missing_indices: list[int]


class AttachmentCompleteRequest(BaseModel):
    final_hash: str = Field(..., min_length=64, max_length=64)
    signature: str


class AttachmentCompleteResponse(BaseModel):
    attachment_id: str
    status: AttachmentStatus
    verified: bool


# ── Relay Schemas ─────────────────────────────────────────────────────


class RelayRegisterRequest(BaseModel):
    relay_url: str = Field(..., max_length=512)
    relay_type: RelayType
    capabilities: list[str] | None = None
    max_event_size: int = Field(default=65536, gt=0)
    signature: str


class RelayResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    relay_id: str
    relay_url: str
    relay_type: RelayType
    last_seen: datetime | None = None
    status: str


class RelayListResponse(BaseModel):
    relays: list[RelayResponse]


# ── Health Schemas ────────────────────────────────────────────────────


class HealthResponse(BaseModel):
    status: str
    version: str
    uptime_seconds: float


class ReadyResponse(BaseModel):
    status: str
    database: str
    redis: str


# ── Error Schema ──────────────────────────────────────────────────────


class ErrorDetail(BaseModel):
    code: str
    message: str
    details: dict | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail

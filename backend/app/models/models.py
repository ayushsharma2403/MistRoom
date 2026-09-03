"""
MistRoom SQLAlchemy ORM Models

These models define the MySQL schema for the MistRoom relay backend.
The server stores ONLY encrypted data and public metadata.
Private keys, plaintext messages, and decrypted attachments are NEVER stored.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


# ── Helper ────────────────────────────────────────────────────────────


def _uuid() -> str:
    return str(uuid.uuid4())


# ── Devices ───────────────────────────────────────────────────────────


class Device(Base):
    """
    Registered device identity.
    Stores public information only. Never stores private keys.
    """

    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    fingerprint: Mapped[str] = mapped_column(
        String(32), unique=True, nullable=False, index=True,
        comment="SHA-256(Ed25519 public key)[0:16] as hex"
    )
    display_name_encrypted: Mapped[bytes | None] = mapped_column(
        LargeBinary(256), nullable=True,
        comment="Display name encrypted with device key — server cannot read"
    )
    protocol_version: Mapped[int] = mapped_column(SmallInteger, default=1)
    capabilities: Mapped[int] = mapped_column(Integer, default=0, comment="Bitfield of capabilities")
    is_blocked: Mapped[bool] = mapped_column(Boolean, default=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    registered_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    public_keys: Mapped[list[DevicePublicKey]] = relationship(
        back_populates="device", cascade="all, delete-orphan"
    )
    sent_envelopes: Mapped[list[MessageEnvelope]] = relationship(
        foreign_keys="MessageEnvelope.sender_fingerprint",
        back_populates="sender_device",
    )


class DevicePublicKey(Base):
    """
    Public keys for a device. Only public keys — NEVER private keys.
    Supports key rotation by keeping history.
    """

    __tablename__ = "device_public_keys"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    device_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
    )
    key_type: Mapped[str] = mapped_column(
        Enum("ed25519", "x25519", name="key_type_enum"), nullable=False
    )
    public_key: Mapped[bytes] = mapped_column(
        LargeBinary(64), nullable=False,
        comment="Raw public key bytes (32 bytes for Ed25519/X25519)"
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    device: Mapped[Device] = relationship(back_populates="public_keys")

    __table_args__ = (
        Index("ix_device_keys_device_active", "device_id", "key_type", "is_active"),
    )


# ── Conversations ─────────────────────────────────────────────────────


class Conversation(Base):
    """
    Conversation metadata. Uses blinded IDs — server doesn't know participants
    beyond what's in the members table.
    """

    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    conversation_type: Mapped[str] = mapped_column(
        Enum("direct", "group", "channel", name="conversation_type_enum"),
        nullable=False, default="direct"
    )
    created_by_fingerprint: Mapped[str] = mapped_column(String(32), nullable=False)
    encrypted_metadata: Mapped[bytes | None] = mapped_column(
        LargeBinary(1024), nullable=True,
        comment="Encrypted conversation name/description — server cannot read"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    members: Mapped[list[ConversationMember]] = relationship(
        back_populates="conversation", cascade="all, delete-orphan"
    )


class ConversationMember(Base):
    """Tracks which device fingerprints belong to a conversation."""

    __tablename__ = "conversation_members"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    conversation_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    device_fingerprint: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    role: Mapped[str] = mapped_column(
        Enum("owner", "admin", "member", name="member_role_enum"),
        nullable=False, default="member"
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    left_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    conversation: Mapped[Conversation] = relationship(back_populates="members")

    __table_args__ = (
        Index("ix_conv_members_conv_device", "conversation_id", "device_fingerprint", unique=True),
    )


# ── Message Envelopes ─────────────────────────────────────────────────


class MessageEnvelope(Base):
    """
    Encrypted message envelope stored for relay delivery.
    The server stores ONLY ciphertext — it cannot decrypt message content.

    Retention: envelopes older than envelope_retention_hours are purged.
    """

    __tablename__ = "message_envelopes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    sender_fingerprint: Mapped[str] = mapped_column(
        String(32), ForeignKey("devices.fingerprint"), nullable=False, index=True
    )
    recipient_fingerprint: Mapped[str] = mapped_column(
        String(32), nullable=False, index=True
    )
    encrypted_payload: Mapped[bytes] = mapped_column(
        LargeBinary(65536), nullable=False,
        comment="Encrypted envelope — server cannot decrypt"
    )
    priority: Mapped[str] = mapped_column(
        Enum("CRITICAL", "HIGH", "MEDIUM", "LOW", "BULK", name="priority_enum"),
        nullable=False, default="MEDIUM"
    )
    signature: Mapped[bytes] = mapped_column(
        LargeBinary(64), nullable=False,
        comment="Ed25519 signature over the envelope"
    )
    is_delivered: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    sender_device: Mapped[Device] = relationship(
        foreign_keys=[sender_fingerprint],
        back_populates="sent_envelopes",
    )

    __table_args__ = (
        Index("ix_envelopes_recipient_pending", "recipient_fingerprint", "is_delivered"),
        Index("ix_envelopes_expires", "expires_at"),
    )


# ── Delivery Receipts ─────────────────────────────────────────────────


class DeliveryReceipt(Base):
    """Encrypted delivery/read receipt."""

    __tablename__ = "delivery_receipts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    envelope_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("message_envelopes.id", ondelete="CASCADE"),
        nullable=False, index=True
    )
    device_fingerprint: Mapped[str] = mapped_column(String(32), nullable=False)
    receipt_type: Mapped[str] = mapped_column(
        Enum("DELIVERED", "READ", "FAILED", name="receipt_type_enum"), nullable=False
    )
    encrypted_receipt: Mapped[bytes | None] = mapped_column(
        LargeBinary(256), nullable=True,
        comment="Optional encrypted receipt payload"
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


# ── Attachments ───────────────────────────────────────────────────────


class AttachmentMetadata(Base):
    """
    Metadata for a chunked encrypted attachment transfer.
    All content fields are encrypted — server sees only ciphertext blobs.
    """

    __tablename__ = "attachment_metadata"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    sender_fingerprint: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    recipient_fingerprint: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    encrypted_metadata: Mapped[bytes] = mapped_column(
        LargeBinary(4096), nullable=False,
        comment="Encrypted filename, MIME type, size, etc."
    )
    total_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    chunk_count: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_size: Mapped[int] = mapped_column(Integer, nullable=False)
    file_hash: Mapped[str] = mapped_column(
        String(64), nullable=False,
        comment="SHA-256 of the complete encrypted content"
    )
    status: Mapped[str] = mapped_column(
        Enum("UPLOADING", "COMPLETE", "EXPIRED", "CANCELLED", name="attachment_status_enum"),
        nullable=False, default="UPLOADING"
    )
    completed_chunks: Mapped[int] = mapped_column(Integer, default=0)
    signature: Mapped[bytes] = mapped_column(LargeBinary(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    chunks: Mapped[list[AttachmentChunk]] = relationship(
        back_populates="attachment", cascade="all, delete-orphan"
    )


class AttachmentChunk(Base):
    """
    Individual encrypted chunk of an attachment.
    Stores a reference to the encrypted blob (path or inline for small chunks).
    """

    __tablename__ = "attachment_chunks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    attachment_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("attachment_metadata.id", ondelete="CASCADE"), nullable=False
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_hash: Mapped[str] = mapped_column(
        String(64), nullable=False,
        comment="SHA-256 of this encrypted chunk"
    )
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_path: Mapped[str] = mapped_column(
        String(512), nullable=False,
        comment="Path to encrypted chunk blob on disk"
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    attachment: Mapped[AttachmentMetadata] = relationship(back_populates="chunks")

    __table_args__ = (
        Index("ix_chunks_attachment_index", "attachment_id", "chunk_index", unique=True),
    )


# ── Relay Endpoints ───────────────────────────────────────────────────


class RelayEndpoint(Base):
    """Registry of known Nostr or WebSocket relay endpoints."""

    __tablename__ = "relay_endpoints"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    relay_url: Mapped[str] = mapped_column(String(512), unique=True, nullable=False)
    relay_type: Mapped[str] = mapped_column(
        Enum("NOSTR", "WEBSOCKET", name="relay_type_enum"), nullable=False
    )
    capabilities: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="JSON list of capabilities"
    )
    max_event_size: Mapped[int] = mapped_column(Integer, default=65536)
    status: Mapped[str] = mapped_column(
        Enum("ACTIVE", "INACTIVE", "BANNED", name="relay_status_enum"),
        nullable=False, default="ACTIVE"
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    registered_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


# ── Push Tokens ───────────────────────────────────────────────────────


class PushToken(Base):
    """Optional push notification registration (encrypted token)."""

    __tablename__ = "push_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    device_fingerprint: Mapped[str] = mapped_column(
        String(32), nullable=False, unique=True, index=True
    )
    encrypted_token: Mapped[bytes] = mapped_column(
        LargeBinary(512), nullable=False,
        comment="Push token encrypted with server key"
    )
    platform: Mapped[str] = mapped_column(
        Enum("ANDROID", "IOS", "WEB", name="platform_enum"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )


# ── Audit & Security ─────────────────────────────────────────────────


class AuditEvent(Base):
    """
    Security audit trail. Stores hashed details — never plaintext content.

    Retention: rotate based on policy (e.g., 90 days).
    """

    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    event_type: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True,
        comment="e.g., DEVICE_REGISTERED, KEY_ROTATED, ENVELOPE_SUBMITTED"
    )
    device_fingerprint: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    ip_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True,
        comment="SHA-256 of client IP — not the raw IP"
    )
    details: Mapped[str | None] = mapped_column(
        Text, nullable=True,
        comment="JSON with non-sensitive event metadata"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False, index=True
    )


class RateLimitEvent(Base):
    """Records rate-limit violations for abuse monitoring."""

    __tablename__ = "rate_limit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    identifier_hash: Mapped[str] = mapped_column(
        String(64), nullable=False, index=True,
        comment="SHA-256 of IP or fingerprint"
    )
    endpoint: Mapped[str] = mapped_column(String(128), nullable=False)
    request_count: Mapped[int] = mapped_column(Integer, nullable=False)
    window_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )


class BlockedDevice(Base):
    """Devices blocked from using the relay."""

    __tablename__ = "blocked_devices"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    device_fingerprint: Mapped[str] = mapped_column(
        String(32), unique=True, nullable=False, index=True
    )
    reason: Mapped[str | None] = mapped_column(String(256), nullable=True)
    blocked_by: Mapped[str | None] = mapped_column(
        String(32), nullable=True, comment="Admin fingerprint"
    )
    blocked_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


# ── Feature Flags ─────────────────────────────────────────────────────


class FeatureFlag(Base):
    """Server-side feature toggles."""

    __tablename__ = "feature_flags"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    flag_name: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    description: Mapped[str | None] = mapped_column(String(256), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

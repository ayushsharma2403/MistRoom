"""Initial schema — all core tables

Revision ID: 001_initial
Revises: None
Create Date: 2026-09-03
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── devices ───────────────────────────────────────
    op.create_table(
        "devices",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("fingerprint", sa.String(32), unique=True, nullable=False, index=True),
        sa.Column("display_name_encrypted", sa.LargeBinary(256), nullable=True),
        sa.Column("protocol_version", sa.SmallInteger, default=1),
        sa.Column("capabilities", sa.Integer, default=0),
        sa.Column("is_blocked", sa.Boolean, default=False),
        sa.Column("last_seen_at", sa.DateTime, nullable=True),
        sa.Column("registered_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )

    # ── device_public_keys ────────────────────────────
    op.create_table(
        "device_public_keys",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("device_id", sa.String(36), sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False),
        sa.Column("key_type", sa.Enum("ed25519", "x25519", name="key_type_enum"), nullable=False),
        sa.Column("public_key", sa.LargeBinary(64), nullable=False),
        sa.Column("is_active", sa.Boolean, default=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column("revoked_at", sa.DateTime, nullable=True),
    )
    op.create_index("ix_device_keys_device_active", "device_public_keys", ["device_id", "key_type", "is_active"])

    # ── conversations ─────────────────────────────────
    op.create_table(
        "conversations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("conversation_type", sa.Enum("direct", "group", "channel", name="conversation_type_enum"), nullable=False, default="direct"),
        sa.Column("created_by_fingerprint", sa.String(32), nullable=False),
        sa.Column("encrypted_metadata", sa.LargeBinary(1024), nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )

    # ── conversation_members ──────────────────────────
    op.create_table(
        "conversation_members",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("conversation_id", sa.String(36), sa.ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_fingerprint", sa.String(32), nullable=False, index=True),
        sa.Column("role", sa.Enum("owner", "admin", "member", name="member_role_enum"), nullable=False, default="member"),
        sa.Column("joined_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column("left_at", sa.DateTime, nullable=True),
    )
    op.create_index("ix_conv_members_conv_device", "conversation_members", ["conversation_id", "device_fingerprint"], unique=True)

    # ── message_envelopes ─────────────────────────────
    op.create_table(
        "message_envelopes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sender_fingerprint", sa.String(32), sa.ForeignKey("devices.fingerprint"), nullable=False, index=True),
        sa.Column("recipient_fingerprint", sa.String(32), nullable=False, index=True),
        sa.Column("encrypted_payload", sa.LargeBinary(65536), nullable=False),
        sa.Column("priority", sa.Enum("CRITICAL", "HIGH", "MEDIUM", "LOW", "BULK", name="priority_enum"), nullable=False, default="MEDIUM"),
        sa.Column("signature", sa.LargeBinary(64), nullable=False),
        sa.Column("is_delivered", sa.Boolean, default=False, index=True),
        sa.Column("delivered_at", sa.DateTime, nullable=True),
        sa.Column("expires_at", sa.DateTime, nullable=False, index=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_envelopes_recipient_pending", "message_envelopes", ["recipient_fingerprint", "is_delivered"])
    op.create_index("ix_envelopes_expires", "message_envelopes", ["expires_at"])

    # ── delivery_receipts ─────────────────────────────
    op.create_table(
        "delivery_receipts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("envelope_id", sa.String(36), sa.ForeignKey("message_envelopes.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("device_fingerprint", sa.String(32), nullable=False),
        sa.Column("receipt_type", sa.Enum("DELIVERED", "READ", "FAILED", name="receipt_type_enum"), nullable=False),
        sa.Column("encrypted_receipt", sa.LargeBinary(256), nullable=True),
        sa.Column("received_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )

    # ── attachment_metadata ───────────────────────────
    op.create_table(
        "attachment_metadata",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("sender_fingerprint", sa.String(32), nullable=False, index=True),
        sa.Column("recipient_fingerprint", sa.String(32), nullable=False, index=True),
        sa.Column("encrypted_metadata", sa.LargeBinary(4096), nullable=False),
        sa.Column("total_size", sa.BigInteger, nullable=False),
        sa.Column("chunk_count", sa.Integer, nullable=False),
        sa.Column("chunk_size", sa.Integer, nullable=False),
        sa.Column("file_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.Enum("UPLOADING", "COMPLETE", "EXPIRED", "CANCELLED", name="attachment_status_enum"), nullable=False, default="UPLOADING"),
        sa.Column("completed_chunks", sa.Integer, default=0),
        sa.Column("signature", sa.LargeBinary(64), nullable=False),
        sa.Column("expires_at", sa.DateTime, nullable=False, index=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )

    # ── attachment_chunks ─────────────────────────────
    op.create_table(
        "attachment_chunks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("attachment_id", sa.String(36), sa.ForeignKey("attachment_metadata.id", ondelete="CASCADE"), nullable=False),
        sa.Column("chunk_index", sa.Integer, nullable=False),
        sa.Column("chunk_hash", sa.String(64), nullable=False),
        sa.Column("size", sa.Integer, nullable=False),
        sa.Column("storage_path", sa.String(512), nullable=False),
        sa.Column("received_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_chunks_attachment_index", "attachment_chunks", ["attachment_id", "chunk_index"], unique=True)

    # ── relay_endpoints ───────────────────────────────
    op.create_table(
        "relay_endpoints",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("relay_url", sa.String(512), unique=True, nullable=False),
        sa.Column("relay_type", sa.Enum("NOSTR", "WEBSOCKET", name="relay_type_enum"), nullable=False),
        sa.Column("capabilities", sa.Text, nullable=True),
        sa.Column("max_event_size", sa.Integer, default=65536),
        sa.Column("status", sa.Enum("ACTIVE", "INACTIVE", "BANNED", name="relay_status_enum"), nullable=False, default="ACTIVE"),
        sa.Column("last_seen_at", sa.DateTime, nullable=True),
        sa.Column("registered_by", sa.String(32), nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )

    # ── push_tokens ───────────────────────────────────
    op.create_table(
        "push_tokens",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("device_fingerprint", sa.String(32), unique=True, nullable=False, index=True),
        sa.Column("encrypted_token", sa.LargeBinary(512), nullable=False),
        sa.Column("platform", sa.Enum("ANDROID", "IOS", "WEB", name="platform_enum"), nullable=False),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )

    # ── audit_events ──────────────────────────────────
    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("event_type", sa.String(64), nullable=False, index=True),
        sa.Column("device_fingerprint", sa.String(32), nullable=True, index=True),
        sa.Column("ip_hash", sa.String(64), nullable=True),
        sa.Column("details", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False, index=True),
    )

    # ── rate_limit_events ─────────────────────────────
    op.create_table(
        "rate_limit_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("identifier_hash", sa.String(64), nullable=False, index=True),
        sa.Column("endpoint", sa.String(128), nullable=False),
        sa.Column("request_count", sa.Integer, nullable=False),
        sa.Column("window_start", sa.DateTime, nullable=False),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )

    # ── blocked_devices ───────────────────────────────
    op.create_table(
        "blocked_devices",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("device_fingerprint", sa.String(32), unique=True, nullable=False, index=True),
        sa.Column("reason", sa.String(256), nullable=True),
        sa.Column("blocked_by", sa.String(32), nullable=True),
        sa.Column("blocked_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime, nullable=True),
    )

    # ── feature_flags ─────────────────────────────────
    op.create_table(
        "feature_flags",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("flag_name", sa.String(64), unique=True, nullable=False),
        sa.Column("is_enabled", sa.Boolean, default=False),
        sa.Column("description", sa.String(256), nullable=True),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("feature_flags")
    op.drop_table("blocked_devices")
    op.drop_table("rate_limit_events")
    op.drop_table("audit_events")
    op.drop_table("push_tokens")
    op.drop_table("relay_endpoints")
    op.drop_table("attachment_chunks")
    op.drop_table("attachment_metadata")
    op.drop_table("delivery_receipts")
    op.drop_table("message_envelopes")
    op.drop_table("conversation_members")
    op.drop_table("conversations")
    op.drop_table("device_public_keys")
    op.drop_table("devices")

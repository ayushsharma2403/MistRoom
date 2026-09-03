"""Tests for Pydantic schemas — validation rules."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.schemas import (
    DeviceRegisterRequest,
    EnvelopeSubmitRequest,
    Priority,
)


class TestDeviceRegisterSchema:
    """Test device registration schema validation."""

    def test_valid_request(self) -> None:
        req = DeviceRegisterRequest(
            fingerprint="a1b2c3d4e5f67890a1b2c3d4e5f67890",
            ed25519_public_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            x25519_public_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            protocol_version=1,
            capabilities=255,
            timestamp=1693750000000,
            signature="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        )
        assert req.fingerprint == "a1b2c3d4e5f67890a1b2c3d4e5f67890"

    def test_fingerprint_must_be_32_chars(self) -> None:
        with pytest.raises(ValidationError):
            DeviceRegisterRequest(
                fingerprint="short",
                ed25519_public_key="AAAA",
                x25519_public_key="AAAA",
                timestamp=1693750000000,
                signature="AAAA",
            )

    def test_fingerprint_must_be_hex(self) -> None:
        with pytest.raises(ValidationError):
            DeviceRegisterRequest(
                fingerprint="zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
                ed25519_public_key="AAAA",
                x25519_public_key="AAAA",
                timestamp=1693750000000,
                signature="AAAA",
            )

    def test_fingerprint_normalized_to_lowercase(self) -> None:
        req = DeviceRegisterRequest(
            fingerprint="A1B2C3D4E5F67890A1B2C3D4E5F67890",
            ed25519_public_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            x25519_public_key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            timestamp=1693750000000,
            signature="AAAA",
        )
        assert req.fingerprint == "a1b2c3d4e5f67890a1b2c3d4e5f67890"


class TestEnvelopeSubmitSchema:
    """Test envelope submission schema validation."""

    def test_valid_envelope(self) -> None:
        req = EnvelopeSubmitRequest(
            envelope_id="12345678-1234-1234-1234-123456789012",
            sender_fingerprint="a1b2c3d4e5f67890a1b2c3d4e5f67890",
            recipient_fingerprint="f0e1d2c3b4a596870f1e2d3c4b5a6978",
            encrypted_payload="dGVzdA==",
            priority=Priority.HIGH,
            expires_at="2026-09-10T12:00:00Z",
            signature="dGVzdA==",
        )
        assert req.priority == Priority.HIGH

    def test_default_priority_is_medium(self) -> None:
        req = EnvelopeSubmitRequest(
            envelope_id="12345678-1234-1234-1234-123456789012",
            sender_fingerprint="a1b2c3d4e5f67890a1b2c3d4e5f67890",
            recipient_fingerprint="f0e1d2c3b4a596870f1e2d3c4b5a6978",
            encrypted_payload="dGVzdA==",
            expires_at="2026-09-10T12:00:00Z",
            signature="dGVzdA==",
        )
        assert req.priority == Priority.MEDIUM

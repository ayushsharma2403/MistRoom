"""Pytest configuration and shared fixtures for MistRoom backend tests.

Uses an in-memory SQLite database so tests run without Docker or MySQL.
Each test gets a fresh database via function-scoped engine/session override.
"""

from __future__ import annotations

import base64
import hashlib
import os
import time
from collections.abc import AsyncGenerator
from dataclasses import dataclass

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from nacl.signing import SigningKey
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.db.base import Base
from app.models.models import (  # noqa: F401  — ensure all models are registered on Base.metadata
    AttachmentChunk,
    AttachmentMetadata,
    AuditEvent,
    BlockedDevice,
    Conversation,
    ConversationMember,
    DeliveryReceipt,
    Device,
    DevicePublicKey,
    FeatureFlag,
    MessageEnvelope,
    PushToken,
    RateLimitEvent,
    RelayEndpoint,
)

# ── Device Identity Helper ────────────────────────────────────────────


@dataclass
class DeviceIdentity:
    """Test device identity with Ed25519 and X25519 key pairs."""

    signing_key: SigningKey
    fingerprint: str
    ed25519_public_b64: str
    x25519_public_b64: str
    ed25519_public_bytes: bytes
    x25519_public_bytes: bytes

    def sign(self, message: bytes) -> bytes:
        """Sign a message with Ed25519."""
        return self.signing_key.sign(message).signature

    def auth_header(self, method: str, path: str) -> str:
        """Build a MistRoom Authorization header value."""
        timestamp_ms = int(time.time() * 1000)
        msg = f"{self.fingerprint}{timestamp_ms}{method.upper()}{path}".encode()
        sig = self.sign(msg)
        sig_b64 = base64.b64encode(sig).decode()
        return f"MistRoom {self.fingerprint}:{timestamp_ms}:{sig_b64}"

    def auth_headers(self, method: str, path: str) -> dict[str, str]:
        """Return headers dict with Authorization."""
        return {"Authorization": self.auth_header(method, path)}


def make_device_identity() -> DeviceIdentity:
    """Generate a fresh Ed25519 identity with derived fingerprint and X25519 key."""
    signing_key = SigningKey.generate()
    ed_pub = bytes(signing_key.verify_key)
    fingerprint = hashlib.sha256(ed_pub).hexdigest()[:32]

    # Generate X25519 key (use random 32 bytes for testing)
    x25519_pub = os.urandom(32)

    return DeviceIdentity(
        signing_key=signing_key,
        fingerprint=fingerprint,
        ed25519_public_b64=base64.b64encode(ed_pub).decode(),
        x25519_public_b64=base64.b64encode(x25519_pub).decode(),
        ed25519_public_bytes=ed_pub,
        x25519_public_bytes=x25519_pub,
    )


# ── Database Fixtures ─────────────────────────────────────────────────


@pytest_asyncio.fixture
async def _test_db():
    """
    Create a per-test in-memory SQLite database.

    Yields an (engine, session_factory) tuple.
    Tables are created fresh for every test function.
    """
    # SQLite in-memory with aiosqlite driver
    test_engine = create_async_engine(
        "sqlite+aiosqlite://",
        echo=False,
    )

    # SQLite doesn't enforce FK by default; enable it
    @event.listens_for(test_engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_conn, _connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    # Create all tables
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    test_session_factory = async_sessionmaker(
        test_engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )

    yield test_engine, test_session_factory

    # Teardown
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await test_engine.dispose()


@pytest_asyncio.fixture
async def client(_test_db) -> AsyncGenerator[AsyncClient, None]:
    """Async test client with DB dependency overridden to use SQLite."""
    from app.api.deps import get_db
    from app.main import app

    _engine, session_factory = _test_db

    async def _override_get_db() -> AsyncGenerator[AsyncSession, None]:
        async with session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = _override_get_db

    # Also patch the WebSocket module's session factory so WS handlers
    # use the test database
    import app.api.v1.websocket as ws_mod
    import app.db.session as session_mod

    original_factory = ws_mod.async_session_factory
    ws_mod.async_session_factory = session_factory
    session_mod.async_session_factory = session_factory

    transport = ASGITransport(app=app)
    from app.core.rate_limit import _memory_store
    _memory_store.buckets.clear()
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    # Restore
    _memory_store.buckets.clear()
    app.dependency_overrides.clear()
    ws_mod.async_session_factory = original_factory
    session_mod.async_session_factory = original_factory


# ── Identity Fixtures ─────────────────────────────────────────────────


@pytest.fixture
def device_identity() -> DeviceIdentity:
    """Generate a fresh device identity for testing."""
    return make_device_identity()


@pytest.fixture
def second_device_identity() -> DeviceIdentity:
    """Generate a second device identity for two-party tests."""
    return make_device_identity()


@pytest.fixture
def admin_headers() -> dict[str, str]:
    """Headers with admin API key."""
    from app.core.config import settings

    return {"X-Admin-Key": settings.admin_api_key}


# ── Registration Helper ──────────────────────────────────────────────


async def register_device(
    client: AsyncClient, identity: DeviceIdentity
) -> dict:
    """Helper: register a device and return the response data."""
    timestamp_ms = int(time.time() * 1000)
    msg = f"{identity.fingerprint}{timestamp_ms}".encode()
    sig = identity.sign(msg)

    response = await client.post(
        "/api/v1/devices/register",
        json={
            "fingerprint": identity.fingerprint,
            "ed25519_public_key": identity.ed25519_public_b64,
            "x25519_public_key": identity.x25519_public_b64,
            "protocol_version": 1,
            "capabilities": 255,
            "timestamp": timestamp_ms,
            "signature": base64.b64encode(sig).decode(),
        },
    )
    return response.json()

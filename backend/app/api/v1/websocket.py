"""
WebSocket relay endpoint for real-time encrypted envelope forwarding.

Protocol:
    1. Client connects to /api/v1/ws/relay?token=<fingerprint>:<timestamp>:<signature>
       OR sends auth as first message.
    2. Server verifies authentication.
    3. Bidirectional envelope exchange.
    4. PING/PONG heartbeat every 30s.
"""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import UTC, datetime

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.audit import EVENT_WS_CONNECTED, EVENT_WS_DISCONNECTED, log_audit_event
from app.core.auth import (
    build_auth_message,
    check_timestamp_drift,
    parse_auth_header,
    verify_ed25519_signature,
)
from app.db.session import async_session_factory
from app.models.models import Device, DevicePublicKey, MessageEnvelope

logger = structlog.get_logger(__name__)

router = APIRouter(tags=["websocket"])


class ConnectionManager:
    """Manages active WebSocket connections indexed by device fingerprint."""

    def __init__(self) -> None:
        self._connections: dict[str, WebSocket] = {}
        self._lock = asyncio.Lock()

    async def connect(self, fingerprint: str, ws: WebSocket) -> None:
        async with self._lock:
            # Close existing connection for this fingerprint
            old = self._connections.get(fingerprint)
            if old:
                try:
                    await old.close(code=1000, reason="Replaced by new connection")
                except Exception:
                    pass
            self._connections[fingerprint] = ws

    async def disconnect(self, fingerprint: str) -> None:
        async with self._lock:
            self._connections.pop(fingerprint, None)

    async def send_to(self, fingerprint: str, data: dict) -> bool:
        """Send a message to a connected device. Returns True if sent."""
        async with self._lock:
            ws = self._connections.get(fingerprint)
        if ws:
            try:
                await ws.send_json(data)
                return True
            except Exception:
                await self.disconnect(fingerprint)
                return False
        return False

    @property
    def active_count(self) -> int:
        return len(self._connections)

    def is_online(self, fingerprint: str) -> bool:
        return fingerprint in self._connections


# Global connection manager
manager = ConnectionManager()


async def _authenticate_ws(
    ws: WebSocket,
    token: str | None,
) -> str | None:
    """
    Authenticate a WebSocket connection.

    Supports:
    1. Query param: ?token=fingerprint:timestamp:signature
    2. First message: {"type": "AUTH", "data": {"token": "fingerprint:timestamp:signature"}}

    Returns the authenticated fingerprint or None.
    """
    auth_token = token

    # If no query param token, wait for first message
    if not auth_token:
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=10.0)
            msg = json.loads(raw)
            if msg.get("type") == "AUTH" and "data" in msg:
                auth_token = msg["data"].get("token", "")
            else:
                await ws.send_json({
                    "type": "ERROR",
                    "data": {"code": "AUTH_REQUIRED", "message": "First message must be AUTH"},
                })
                return None
        except TimeoutError:
            await ws.send_json({
                "type": "ERROR",
                "data": {"code": "AUTH_TIMEOUT", "message": "Authentication timeout"},
            })
            return None
        except Exception:
            return None

    if not auth_token:
        return None

    # Parse token as "fingerprint:timestamp:signature"
    try:
        fingerprint, timestamp_ms, signature = parse_auth_header(f"MistRoom {auth_token}")
    except Exception:
        await ws.send_json({
            "type": "ERROR",
            "data": {"code": "INVALID_AUTH", "message": "Invalid auth token format"},
        })
        return None

    # Check timestamp
    try:
        check_timestamp_drift(timestamp_ms)
    except Exception:
        await ws.send_json({
            "type": "ERROR",
            "data": {"code": "TIMESTAMP_EXPIRED", "message": "Auth token expired"},
        })
        return None

    # Verify against database
    async with async_session_factory() as db:
        result = await db.execute(
            select(Device).where(Device.fingerprint == fingerprint)
        )
        device = result.scalar_one_or_none()
        if not device:
            await ws.send_json({
                "type": "ERROR",
                "data": {"code": "DEVICE_NOT_FOUND", "message": "Unknown device"},
            })
            return None

        # Get Ed25519 key
        key_result = await db.execute(
            select(DevicePublicKey).where(
                DevicePublicKey.device_id == device.id,
                DevicePublicKey.key_type == "ed25519",
                DevicePublicKey.is_active.is_(True),
            )
        )
        ed_key = key_result.scalar_one_or_none()
        if not ed_key:
            return None

        # Build message for WS auth: fingerprint + timestamp + "GET" + "/api/v1/ws/relay"
        message = build_auth_message(fingerprint, timestamp_ms, "GET", "/api/v1/ws/relay")
        if not verify_ed25519_signature(ed_key.public_key, message, signature):
            await ws.send_json({
                "type": "ERROR",
                "data": {"code": "INVALID_SIGNATURE", "message": "Signature verification failed"},
            })
            return None

        # Update last_seen
        device.last_seen_at = datetime.now(UTC)
        await db.commit()

    return fingerprint


async def _handle_envelope(
    fingerprint: str,
    data: dict,
) -> dict | None:
    """Process an incoming envelope from a WebSocket client."""
    required = ["envelope_id", "recipient_fingerprint", "encrypted_payload", "signature"]
    for field in required:
        if field not in data:
            return {"type": "ERROR", "data": {"code": "MISSING_FIELD", "message": f"Missing: {field}"}}

    try:
        payload_bytes = base64.b64decode(data["encrypted_payload"])
        sig_bytes = base64.b64decode(data["signature"])
    except Exception:
        return {"type": "ERROR", "data": {"code": "INVALID_BASE64", "message": "Invalid base64 encoding"}}

    from app.core.config import settings

    if len(payload_bytes) > settings.max_envelope_size_bytes:
        return {"type": "ERROR", "data": {"code": "PAYLOAD_TOO_LARGE", "message": "Envelope exceeds size limit"}}

    # Store in database
    async with async_session_factory() as db:
        from datetime import timedelta

        envelope = MessageEnvelope(
            id=data["envelope_id"],
            sender_fingerprint=fingerprint,
            recipient_fingerprint=data["recipient_fingerprint"],
            encrypted_payload=payload_bytes,
            priority=data.get("priority", "MEDIUM"),
            signature=sig_bytes,
            expires_at=datetime.now(UTC) + timedelta(hours=settings.envelope_retention_hours),
        )
        db.add(envelope)

        # Try to forward to online recipient
        recipient_fp = data["recipient_fingerprint"]
        forwarded = await manager.send_to(recipient_fp, {
            "type": "ENVELOPE",
            "data": {
                "envelope_id": data["envelope_id"],
                "sender_fingerprint": fingerprint,
                "encrypted_payload": data["encrypted_payload"],
                "signature": data["signature"],
                "priority": data.get("priority", "MEDIUM"),
            },
        })

        if forwarded:
            envelope.is_delivered = True
            envelope.delivered_at = datetime.now(UTC)

        await db.commit()

    return {
        "type": "ACK",
        "data": {
            "envelope_id": data["envelope_id"],
            "status": "DELIVERED" if forwarded else "QUEUED",
        },
    }


@router.websocket("/ws/relay")
async def websocket_relay(
    ws: WebSocket,
    token: str | None = None,
) -> None:
    """Real-time encrypted envelope relay via WebSocket."""
    await ws.accept()

    # Authenticate
    fingerprint = await _authenticate_ws(ws, token)
    if not fingerprint:
        await ws.close(code=1008, reason="Authentication failed")
        return

    # Register connection
    await manager.connect(fingerprint, ws)

    # Log connection
    async with async_session_factory() as db:
        await log_audit_event(
            db,
            EVENT_WS_CONNECTED,
            device_fingerprint=fingerprint,
        )
        await db.commit()

    logger.info("ws_connected", fingerprint=fingerprint)

    # Send auth success
    await ws.send_json({
        "type": "AUTH_OK",
        "data": {"fingerprint": fingerprint},
    })

    try:
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=60.0)
            except TimeoutError:
                # Send server-side ping if no activity
                try:
                    await ws.send_json({"type": "PING"})
                except Exception:
                    break
                continue

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({
                    "type": "ERROR",
                    "data": {"code": "INVALID_JSON", "message": "Message must be valid JSON"},
                })
                continue

            msg_type = msg.get("type", "").upper()

            if msg_type == "PING":
                await ws.send_json({"type": "PONG"})

            elif msg_type == "PONG":
                pass  # Client responding to our ping

            elif msg_type == "ENVELOPE":
                response = await _handle_envelope(fingerprint, msg.get("data", {}))
                if response:
                    await ws.send_json(response)

            else:
                await ws.send_json({
                    "type": "ERROR",
                    "data": {"code": "UNKNOWN_TYPE", "message": f"Unknown message type: {msg_type}"},
                })

    except WebSocketDisconnect:
        logger.info("ws_disconnected", fingerprint=fingerprint)
    except Exception as exc:
        logger.error("ws_error", fingerprint=fingerprint, error=str(exc))
    finally:
        await manager.disconnect(fingerprint)

        async with async_session_factory() as db:
            await log_audit_event(
                db,
                EVENT_WS_DISCONNECTED,
                device_fingerprint=fingerprint,
            )
            await db.commit()

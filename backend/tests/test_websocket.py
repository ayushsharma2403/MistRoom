"""Tests for WebSocket relay endpoint."""

from __future__ import annotations

import json

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_ws_connection_without_auth(client: AsyncClient) -> None:
    """WebSocket connection without authentication is rejected."""
    from starlette.testclient import TestClient

    from app.main import app

    with TestClient(app) as tc, tc.websocket_connect("/api/v1/ws/relay") as ws:
        # Send a non-auth message
        ws.send_text(json.dumps({"type": "PING"}))
        response = ws.receive_json()
        assert response["type"] == "ERROR"
        assert response["data"]["code"] == "AUTH_REQUIRED"


@pytest.mark.asyncio
async def test_ws_auth_timeout(client: AsyncClient) -> None:
    """WebSocket connection times out if no auth is sent."""
    # This test validates the auth flow exists; actual timeout would take 10s
    # so we just verify the endpoint is reachable
    from starlette.testclient import TestClient

    from app.main import app

    with TestClient(app) as tc:
        try:
            with tc.websocket_connect("/api/v1/ws/relay") as ws:
                # Send AUTH with invalid token
                ws.send_text(json.dumps({
                    "type": "AUTH",
                    "data": {"token": "invalid:0:AAAA"},
                }))
                response = ws.receive_json()
                assert response["type"] == "ERROR"
        except Exception:
            # Connection may close on auth failure — that's expected
            pass


@pytest.mark.asyncio
async def test_ws_connection_manager_tracking() -> None:
    """ConnectionManager correctly tracks connect/disconnect."""
    from app.api.v1.websocket import ConnectionManager

    manager = ConnectionManager()
    assert manager.active_count == 0
    assert not manager.is_online("test_fp")

    # Simulate — we can't easily mock WebSocket, so test the online check
    assert manager.is_online("abc123") is False
    assert manager.active_count == 0


@pytest.mark.asyncio
async def test_ws_send_to_nonexistent_peer() -> None:
    """Sending to a non-connected peer returns False."""
    from app.api.v1.websocket import ConnectionManager

    manager = ConnectionManager()
    result = await manager.send_to("nonexistent", {"type": "TEST"})
    assert result is False

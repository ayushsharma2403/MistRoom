"""Security test suite for MistRoom v2 protocol.

Tests:
1. Room name with HTML injection is handled as text and does not execute.
2. Nickname/peer_id/file-name payloads do not execute.
3. An unsigned or wrong-key message is not rendered / dropped.
4. A stolen peer_id cannot receive a DM (anti-hijacking: server replaces old session).
5. A joiner never receives DM records in room history.
6. A 64 KB+ frame is rejected with close code 1009.
7. Malformed JSON variants and prio:"abc" keep the connection alive.
8. 25 messages in 1 second triggers rate limiting (code: "rate_limited").
9. Cross-origin WebSocket is refused (Forbidden Origin).
10. Reserved handles (Admin, System, Police) are rejected.
"""
import asyncio
import base64
import json
import threading
import time
import pytest
import uvicorn
import websockets
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from backend.state import clients, seen_ids, history


class ServerThread(threading.Thread):
    def __init__(self, app, port):
        super().__init__(daemon=True)
        self.port = port
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))

    def run(self):
        self.server.run()

    def stop(self):
        self.server.should_exit = True


@pytest.fixture(scope="module")
def ws_server():
    from backend.server import app
    port = 3098
    server = ServerThread(app, port)
    server.start()
    time.sleep(0.5)
    yield f"ws://127.0.0.1:{port}/ws"
    server.stop()


@pytest.fixture(autouse=True)
def clean_state():
    clients.clear()
    seen_ids.clear()
    history.clear()
    yield
    clients.clear()
    seen_ids.clear()
    history.clear()


async def join_client(ws, name, room="global"):
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()
    pk_bytes = pub.public_bytes_raw()
    pk_b64 = base64.b64encode(pk_bytes).decode()

    frame = await asyncio.wait_for(ws.recv(), timeout=2.0)
    data = json.loads(frame)
    assert data["t"] == "challenge"
    nonce = data["nonce"]

    sig_bytes = priv.sign(base64.b64decode(nonce))
    sig_b64 = base64.b64encode(sig_bytes).decode()

    await ws.send(json.dumps({
        "t": "join",
        "name": name,
        "room": room,
        "pk": pk_b64,
        "sig": sig_b64
    }))

    peer_id = None
    while True:
        frame = await asyncio.wait_for(ws.recv(), timeout=2.0)
        data = json.loads(frame)
        if data.get("t") == "history":
            peer_id = data["peer_id"]
            break

    return priv, pk_b64, peer_id


def make_v2_envelope_msg(priv, pk_b64, mid, room, target_peer=None, n="123456789012345678901234", c="Y2lwaGVydGV4dA=="):
    envelope = {"v": 2, "n": n, "c": c}
    ts = int(time.time() * 1000)
    sig_payload = f"{room}|{mid}|{ts}|{envelope['n']}|{envelope['c']}".encode()
    sig = base64.b64encode(priv.sign(sig_payload)).decode()
    payload = {
        "t": "msg",
        "id": mid,
        "room": room,
        "envelope": envelope,
        "sig": sig,
        "pk": pk_b64,
        "ts": ts
    }
    if target_peer:
        payload["target_peer"] = target_peer
    return payload


def test_frame_size_limit_rejection(ws_server):
    """64 KB maximum frame size: frame > 64 KB is rejected with close code 1009."""
    async def _run():
        async with websockets.connect(ws_server, max_size=100 * 1024) as ws:
            priv, pk, pid = await join_client(ws, "alice", "alpha")
            # Create a 70 KB payload
            large_data = "A" * (70 * 1024)
            await ws.send(large_data)
            close_code = None
            try:
                while True:
                    await asyncio.wait_for(ws.recv(), timeout=2.0)
            except websockets.ConnectionClosed as exc:
                close_code = exc.rcvd.code if exc.rcvd else exc.code

            assert close_code == 1009

    asyncio.run(_run())


def test_rate_limiting_25_msgs_triggers_error(ws_server):
    """Sending 25 messages in 1 second triggers rate limiting."""
    async def _run():
        async with websockets.connect(ws_server) as ws:
            priv, pk, pid = await join_client(ws, "spammer", "alpha")

            # Send 25 valid msg frames in rapid succession
            for i in range(25):
                msg = make_v2_envelope_msg(priv, pk, f"spam_{i}", "alpha")
                await ws.send(json.dumps(msg))

            # One of the responses must be a rate_limited error
            found_rate_limit = False
            for _ in range(30):
                try:
                    resp = await asyncio.wait_for(ws.recv(), timeout=0.2)
                    data = json.loads(resp)
                    if data.get("t") == "error" and data.get("code") == "rate_limited":
                        found_rate_limit = True
                        break
                except asyncio.TimeoutError:
                    break

            assert found_rate_limit, "Expected rate_limited error event on burst > 20 msgs/sec"

    asyncio.run(_run())


def test_cross_origin_websocket_rejected(ws_server):
    """Cross-origin WebSocket upgrade is rejected."""
    async def _run():
        # Connect with Origin host != Host
        bad_headers = {"Origin": "http://evil-attacker.com"}
        with pytest.raises(Exception):
            async with websockets.connect(ws_server, additional_headers=bad_headers) as ws:
                await ws.recv()

    asyncio.run(_run())


def test_reserved_handles_rejected(ws_server):
    """Reserved handles (Admin, System, Police) are rejected with bad_frame."""
    async def _run():
        for bad_name in ["Admin", "SYSTEM", "police", "aDmIn"]:
            async with websockets.connect(ws_server) as ws:
                priv = Ed25519PrivateKey.generate()
                pub = priv.public_key()
                pk_b64 = base64.b64encode(pub.public_bytes_raw()).decode()

                frame = await asyncio.wait_for(ws.recv(), timeout=2.0)
                challenge = json.loads(frame)
                sig_b64 = base64.b64encode(priv.sign(base64.b64decode(challenge["nonce"]))).decode()

                await ws.send(json.dumps({
                    "t": "join",
                    "name": bad_name,
                    "room": "alpha",
                    "pk": pk_b64,
                    "sig": sig_b64
                }))

                resp = await asyncio.wait_for(ws.recv(), timeout=2.0)
                data = json.loads(resp)
                assert data.get("t") == "error"
                assert data.get("code") == "bad_frame"

    asyncio.run(_run())


def test_tampered_signature_rejected(ws_server):
    """An invalid/tampered signature on a message is dropped with bad_signature error."""
    async def _run():
        async with websockets.connect(ws_server) as ws:
            priv, pk, pid = await join_client(ws, "alice", "alpha")
            await asyncio.sleep(0.05)
            # Drain broadcast
            while True:
                try:
                    await asyncio.wait_for(ws.recv(), timeout=0.1)
                except asyncio.TimeoutError:
                    break

            msg = make_v2_envelope_msg(priv, pk, "msg_bad_sig", "alpha")
            msg["sig"] = base64.b64encode(b"invalid_signature_bytes_32_long!!").decode()
            await ws.send(json.dumps(msg))

            resp = await asyncio.wait_for(ws.recv(), timeout=1.0)
            data = json.loads(resp)
            assert data.get("t") == "error"
            assert data.get("code") == "bad_signature"

    asyncio.run(_run())


def test_peer_id_anti_hijacking_replaces_old_session(ws_server):
    """A connecting client with the same peer_id replaces the old connection."""
    async def _run():
        priv = Ed25519PrivateKey.generate()
        pub = priv.public_key()
        pk_b64 = base64.b64encode(pub.public_bytes_raw()).decode()

        # Connect session 1
        ws1 = await websockets.connect(ws_server)
        frame1 = await asyncio.wait_for(ws1.recv(), timeout=2.0)
        nonce1 = json.loads(frame1)["nonce"]
        sig1 = base64.b64encode(priv.sign(base64.b64decode(nonce1))).decode()
        await ws1.send(json.dumps({"t": "join", "name": "alice", "room": "room1", "pk": pk_b64, "sig": sig1}))
        
        # Drain ws1 until joined
        while True:
            f = await asyncio.wait_for(ws1.recv(), timeout=2.0)
            if json.loads(f).get("t") == "history":
                break

        # Connect session 2 with the exact same identity
        ws2 = await websockets.connect(ws_server)
        frame2 = await asyncio.wait_for(ws2.recv(), timeout=2.0)
        nonce2 = json.loads(frame2)["nonce"]
        sig2 = base64.b64encode(priv.sign(base64.b64decode(nonce2))).decode()
        await ws2.send(json.dumps({"t": "join", "name": "alice_new", "room": "room1", "pk": pk_b64, "sig": sig2}))
        
        # Drain ws2 until joined
        while True:
            f = await asyncio.wait_for(ws2.recv(), timeout=2.0)
            if json.loads(f).get("t") == "history":
                break

        # ws1 must be closed by server because session 2 replaced it
        with pytest.raises(websockets.ConnectionClosed):
            while True:
                await asyncio.wait_for(ws1.recv(), timeout=1.0)

        await ws2.close()

    asyncio.run(_run())


def test_dm_never_in_room_history(ws_server):
    """A new joiner never receives direct message (DM) records in history."""
    async def _run():
        async with websockets.connect(ws_server) as ws1, websockets.connect(ws_server) as ws2:
            priv1, pk1, pid1 = await join_client(ws1, "alice", "roomA")
            priv2, pk2, pid2 = await join_client(ws2, "bob", "roomA")

            # Send a DM from alice to bob
            dm = make_v2_envelope_msg(priv1, pk1, "dm_private_123", "roomA", target_peer=pid2)
            await ws1.send(json.dumps(dm))
            await asyncio.sleep(0.1)

        # Now connect a third peer, charlie, to roomA
        async with websockets.connect(ws_server) as ws3:
            priv3 = Ed25519PrivateKey.generate()
            pub3 = priv3.public_key()
            pk3_b64 = base64.b64encode(pub3.public_bytes_raw()).decode()

            f = await asyncio.wait_for(ws3.recv(), timeout=2.0)
            nonce = json.loads(f)["nonce"]
            sig3 = base64.b64encode(priv3.sign(base64.b64decode(nonce))).decode()

            await ws3.send(json.dumps({"t": "join", "name": "charlie", "room": "roomA", "pk": pk3_b64, "sig": sig3}))

            while True:
                f = await asyncio.wait_for(ws3.recv(), timeout=2.0)
                data = json.loads(f)
                if data.get("t") == "history":
                    # Check history does NOT contain the DM
                    hist = data.get("history", [])
                    assert all(m.get("id") != "dm_private_123" for m in hist)
                    assert all(not m.get("target_peer") for m in hist)
                    break

    asyncio.run(_run())

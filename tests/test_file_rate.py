import asyncio
import base64
import json
import threading
import time
import pytest
import uvicorn
import websockets
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from backend.state import clients, seen_ids, room_histories, active_beacons, peer_beacon_times, peer_call_times, need_owners


async def recv_until(ws, types, timeout=3.0):
    end = asyncio.get_event_loop().time() + timeout
    while True:
        left = end - asyncio.get_event_loop().time()
        if left <= 0:
            raise AssertionError(f"no {types} frame within {timeout}s")
        frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=left))
        if frame.get("t") in types:
            return frame


class ServerThread(threading.Thread):
    def __init__(self, app, port):
        super().__init__(daemon=True)
        self.port = port
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", ws_max_size=65536))

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
    room_histories.clear()
    active_beacons.clear()
    peer_beacon_times.clear()
    peer_call_times.clear()
    need_owners.clear()
    yield
    clients.clear()
    seen_ids.clear()
    room_histories.clear()
    active_beacons.clear()
    peer_beacon_times.clear()
    peer_call_times.clear()
    need_owners.clear()


async def join_client(ws, name="Alice", room="global"):
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

    while True:
        frame = await asyncio.wait_for(ws.recv(), timeout=2.0)
        data = json.loads(frame)
        if data.get("t") == "history":
            peer_id = data["peer_id"]
            return priv, pk_b64, peer_id, data


@pytest.mark.asyncio
async def test_p2p_file_rate_limit(ws_server):
    """Send 64 p2p_file frames in 2 s; none get rate_limited."""
    headers = {"Origin": "http://127.0.0.1:3098"}
    async with websockets.connect(ws_server, additional_headers=headers) as ws_alice, \
               websockets.connect(ws_server, additional_headers=headers) as ws_bob:
        alice_priv, alice_pk, alice_pid, _ = await join_client(ws_alice, name="Alice", room="global")
        bob_priv, bob_pk, bob_pid, _ = await join_client(ws_bob, name="Bob", room="global")

        received_errors = []

        async def drain_alice_errors():
            try:
                while True:
                    frame = json.loads(await asyncio.wait_for(ws_alice.recv(), timeout=0.1))
                    if frame.get("t") == "error":
                        received_errors.append(frame)
            except (asyncio.TimeoutError, TimeoutError):
                pass

        # Send 64 p2p_file frames in 2 s (~31 ms per frame)
        start = time.monotonic()
        for i in range(64):
            packet = {
                "t": "p2p_file",
                "target": bob_pid,
                "data": {
                    "t": "file_chunk",
                    "fileId": "f_rate_test",
                    "index": i,
                    "totalChunks": 64
                }
            }
            await ws_alice.send(json.dumps(packet))
            await asyncio.sleep(0.02)  # 64 * 0.02 = 1.28 s (< 2 s)

        elapsed = time.monotonic() - start
        assert elapsed <= 2.5

        # Also receive incoming frames on Bob to ensure delivery
        bob_chunks = 0
        end_time = asyncio.get_event_loop().time() + 3.0
        while bob_chunks < 64 and asyncio.get_event_loop().time() < end_time:
            try:
                frame = json.loads(await asyncio.wait_for(ws_bob.recv(), timeout=0.2))
                if frame.get("t") == "p2p_file":
                    bob_chunks += 1
            except (asyncio.TimeoutError, TimeoutError):
                break

        await drain_alice_errors()

        rate_limited_errors = [e for e in received_errors if e.get("code") == "rate_limited"]
        assert len(rate_limited_errors) == 0, f"Got rate_limited errors: {rate_limited_errors}"
        assert bob_chunks == 64

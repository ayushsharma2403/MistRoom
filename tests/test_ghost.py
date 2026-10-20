"""Test ghost mode: set_ghost {on}, peer_leave delta, and ephemeral peer_id."""
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
    port = 3097
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


async def join_ws(ws, name, room="global"):
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

    payload = {
        "t": "join",
        "name": name,
        "room": room,
        "pk": pk_b64,
        "sig": sig_b64
    }
    await ws.send(json.dumps(payload))

    peer_id = None
    while True:
        frame = await asyncio.wait_for(ws.recv(), timeout=2.0)
        data = json.loads(frame)
        if data.get("t") == "history":
            peer_id = data["peer_id"]
            break

    return priv, pk_b64, peer_id


def test_ghost_mode_leave_delta_and_ephemeral_peer_id(ws_server):
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws_alice, websockets.connect(uri) as ws_bob:
            priv_alice, pk_alice, peer_id_alice = await join_ws(ws_alice, "Alice", "test_ghost")
            priv_bob, pk_bob, peer_id_bob = await join_ws(ws_bob, "Bob", "test_ghost")

            # Drain any pending people broadcasts on both
            await asyncio.sleep(0.2)
            while True:
                try:
                    await asyncio.wait_for(ws_bob.recv(), timeout=0.1)
                except asyncio.TimeoutError:
                    break

            # Alice enables ghost mode via set_ghost {on: true}
            await ws_alice.send(json.dumps({"t": "set_ghost", "on": True}))

            # Bob must receive peer_leave delta for Alice within 1 second
            received_peer_leave = False
            start_t = time.time()
            while time.time() - start_t < 1.0:
                try:
                    frame = await asyncio.wait_for(ws_bob.recv(), timeout=0.5)
                    data = json.loads(frame)
                    if data.get("t") == "peer_leave" and data.get("peer_id") == peer_id_alice:
                        received_peer_leave = True
                        break
                except asyncio.TimeoutError:
                    break

            assert received_peer_leave, f"Bob did not receive peer_leave for Alice ({peer_id_alice}) within 1s"

            # Alice sends a message signed with an ephemeral Ed25519 key
            eph_priv = Ed25519PrivateKey.generate()
            eph_pub = eph_priv.public_key()
            eph_pk_bytes = eph_pub.public_bytes_raw()
            eph_pk_b64 = base64.b64encode(eph_pk_bytes).decode()

            mid = f"m_{int(time.time()*1000)}"
            ts = int(time.time() * 1000)
            envelope = {"v": 2, "n": "123456789012345678901234", "c": "Z2hvc3RfbXNn"}
            sig_payload = f"test_ghost|{mid}|{ts}|{envelope['n']}|{envelope['c']}".encode()
            sig_b64 = base64.b64encode(eph_priv.sign(sig_payload)).decode()

            msg_payload = {
                "t": "msg",
                "id": mid,
                "room": "test_ghost",
                "envelope": envelope,
                "sig": sig_b64,
                "pk": eph_pk_b64,
                "ts": ts
            }
            await ws_alice.send(json.dumps(msg_payload))

            # Bob receives the ghost message; its peer_id must differ from Alice's real peer_id
            received_msg = None
            for _ in range(5):
                frame = await asyncio.wait_for(ws_bob.recv(), timeout=2.0)
                data = json.loads(frame)
                if data.get("t") == "msg" and data.get("msg", {}).get("id") == mid:
                    received_msg = data["msg"]
                    break

            assert received_msg is not None, "Bob did not receive ghost message"
            assert received_msg["from"] == "Ghost"
            assert received_msg["peer_id"] != peer_id_alice, (
                f"Ghost message peer_id {received_msg['peer_id']} matched real peer_id {peer_id_alice}"
            )

    asyncio.run(_run())

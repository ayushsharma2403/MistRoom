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
    port = 3110
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
        elif data.get("t") == "error":
            return priv, pk_b64, None, data


def make_signed_msg(priv, pk_b64, mid, room="global", ts=None, nonce="n1", ciphertext="c1", corrupt_sig=False):
    if ts is None:
        ts = int(time.time() * 1000)
    sig_payload = f"{room}|{mid}|{ts}|{nonce}|{ciphertext}".encode()
    if corrupt_sig:
        sig = base64.b64encode(b"invalid_signature_bytes_12345678").decode()
    else:
        sig = base64.b64encode(priv.sign(sig_payload)).decode()
    return {
        "t": "msg",
        "id": mid,
        "room": room,
        "pk": pk_b64,
        "sig": sig,
        "ts": ts,
        "envelope": {
            "v": 2,
            "n": nonce,
            "c": ciphertext
        }
    }


@pytest.mark.asyncio
async def test_invalid_sig_does_not_poison_dedupe(ws_server):
    """Invalid-sig frame with id X does not stop the valid message with id X."""
    headers = {"Origin": "http://127.0.0.1:3110"}
    async with websockets.connect(ws_server, additional_headers=headers) as ws_alice, \
               websockets.connect(ws_server, additional_headers=headers) as ws_bob:
        alice_priv, alice_pk, alice_pid, _ = await join_client(ws_alice, name="Alice", room="global")
        bob_priv, bob_pk, bob_pid, _ = await join_client(ws_bob, name="Bob", room="global")

        msg_id = "msg-poison-test-1"

        # Alice sends message with invalid signature
        bad_msg = make_signed_msg(alice_priv, alice_pk, msg_id, room="global", corrupt_sig=True)
        await ws_alice.send(json.dumps(bad_msg))

        err_frame = await recv_until(ws_alice, ["error"])
        assert err_frame.get("code") == "bad_signature"

        # Now Alice sends valid message with the SAME id X
        good_msg = make_signed_msg(alice_priv, alice_pk, msg_id, room="global", corrupt_sig=False)
        await ws_alice.send(json.dumps(good_msg))

        # Bob should successfully receive it
        delivered = await recv_until(ws_bob, ["msg"])
        assert delivered["msg"]["id"] == msg_id


@pytest.mark.asyncio
async def test_ts_older_than_10_min_rejected(ws_server):
    """Message with ts older than 10 min rejected."""
    headers = {"Origin": "http://127.0.0.1:3110"}
    async with websockets.connect(ws_server, additional_headers=headers) as ws_alice:
        alice_priv, alice_pk, alice_pid, _ = await join_client(ws_alice, name="Alice", room="global")

        msg_id = "msg-old-ts-1"
        # 11 minutes ago (> 600s = 660,000 ms)
        old_ts = int((time.time() - 660) * 1000)
        old_msg = make_signed_msg(alice_priv, alice_pk, msg_id, room="global", ts=old_ts)
        await ws_alice.send(json.dumps(old_msg))

        err_frame = await recv_until(ws_alice, ["error"])
        assert err_frame.get("code") == "bad_frame"


@pytest.mark.asyncio
async def test_reserved_handles_normalized_rejected(ws_server):
    """'Adm1n', 'Ghost', 'a d m i n' rejected."""
    headers = {"Origin": "http://127.0.0.1:3110"}

    for handle in ["Adm1n", "Ghost", "a d m i n"]:
        async with websockets.connect(ws_server, additional_headers=headers) as ws:
            _, _, pid, resp = await join_client(ws, name=handle, room="global")
            assert pid is None
            assert resp.get("t") == "error"
            assert resp.get("code") == "bad_frame"

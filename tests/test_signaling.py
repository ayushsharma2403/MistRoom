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
    port = 3096
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


def make_signed_msg(priv, pk_b64, mid, room="global", cat="sos", prio=1, nonce="n1", ciphertext="c1"):
    ts = int(time.time() * 1000)
    sig_payload = f"{room}|{mid}|{ts}|{nonce}|{ciphertext}".encode()
    sig = base64.b64encode(priv.sign(sig_payload)).decode()
    return {
        "t": "msg",
        "id": mid,
        "room": room,
        "pk": pk_b64,
        "sig": sig,
        "ts": ts,
        "cat": cat,
        "prio": prio,
        "envelope": {
            "v": 2,
            "n": nonce,
            "c": ciphertext
        }
    }


def make_signed_resolve(priv, pk_b64, need_id):
    sig_payload = f"resolve|{need_id}".encode()
    sig = base64.b64encode(priv.sign(sig_payload)).decode()
    return {
        "t": "need_resolved",
        "id": need_id,
        "pk": pk_b64,
        "sig": sig
    }


@pytest.mark.asyncio
async def test_stranger_need_resolved_ignored(ws_server):
    headers = {"Origin": "http://127.0.0.1:3096"}
    async with websockets.connect(ws_server, additional_headers=headers) as ws_alice, \
               websockets.connect(ws_server, additional_headers=headers) as ws_bob:
        alice_priv, alice_pk, alice_pid, _ = await join_client(ws_alice, name="Alice", room="global")
        bob_priv, bob_pk, bob_pid, _ = await join_client(ws_bob, name="Bob", room="global")

        # Alice creates an emergency need
        need_id = "need-123"
        need_msg = make_signed_msg(alice_priv, alice_pk, need_id, room="global", cat="sos")
        await ws_alice.send(json.dumps(need_msg))

        # Ensure Bob receives the need
        msg_frame = await recv_until(ws_bob, ["msg"])
        assert msg_frame["msg"]["id"] == need_id

        # Bob (stranger) attempts to resolve Alice's need
        bob_resolve = make_signed_resolve(bob_priv, bob_pk, need_id)
        await ws_bob.send(json.dumps(bob_resolve))

        # Bob should receive a forbidden error
        err_frame = await recv_until(ws_bob, ["error"])
        assert err_frame.get("code") == "forbidden"

        # Alice (owner) resolves her need
        alice_resolve = make_signed_resolve(alice_priv, alice_pk, need_id)
        await ws_alice.send(json.dumps(alice_resolve))

        # Both should receive the resolved frame
        resolved_frame = await recv_until(ws_bob, ["need_resolved"])
        assert resolved_frame.get("id") == need_id
        assert resolved_frame.get("pk") == alice_pk


@pytest.mark.asyncio
async def test_cross_room_call_invite_rejected(ws_server):
    headers = {"Origin": "http://127.0.0.1:3096"}
    async with websockets.connect(ws_server, additional_headers=headers) as ws_alice, \
               websockets.connect(ws_server, additional_headers=headers) as ws_bob:
        alice_priv, alice_pk, alice_pid, _ = await join_client(ws_alice, name="Alice", room="room-a")
        bob_priv, bob_pk, bob_pid, _ = await join_client(ws_bob, name="Bob", room="room-b")

        # Alice tries to invite Bob who is in room-b
        call_msg = {
            "t": "call_invite",
            "target": bob_pid,
            "data": {"sdp": "dummy"}
        }
        await ws_alice.send(json.dumps(call_msg))

        err_frame = await recv_until(ws_alice, ["error"])
        assert err_frame.get("code") == "room_mismatch"


@pytest.mark.asyncio
async def test_fourth_call_invite_rate_limited(ws_server):
    headers = {"Origin": "http://127.0.0.1:3096"}
    async with websockets.connect(ws_server, additional_headers=headers) as ws_alice, \
               websockets.connect(ws_server, additional_headers=headers) as ws_bob:
        alice_priv, alice_pk, alice_pid, _ = await join_client(ws_alice, name="Alice", room="global")
        bob_priv, bob_pk, bob_pid, _ = await join_client(ws_bob, name="Bob", room="global")

        call_msg = {
            "t": "call_invite",
            "target": bob_pid,
            "data": {"sdp": "dummy"}
        }

        # Send 3 call_invites
        for _ in range(3):
            await ws_alice.send(json.dumps(call_msg))
            invite_frame = await recv_until(ws_bob, ["call_invite"])
            assert invite_frame.get("sender") == alice_pid
            assert invite_frame.get("from_peer") == alice_pid

        # 4th call_invite in a minute should be rate limited
        await ws_alice.send(json.dumps(call_msg))
        err_frame = await recv_until(ws_alice, ["error"])
        assert err_frame.get("code") == "rate_limited"

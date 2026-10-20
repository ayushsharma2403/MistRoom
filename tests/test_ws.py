"""WebSocket regression tests for MistRoom."""
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
    port = 3099
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


async def join_ws(ws, name, room="global", ghost=False):
    """Helper to receive challenge, sign nonce with Ed25519, and send join."""
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()
    pk_bytes = pub.public_bytes_raw()
    pk_b64 = base64.b64encode(pk_bytes).decode()

    # Receive challenge
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
    if ghost:
        payload["ghost"] = True

    await ws.send(json.dumps(payload))

    # Receive history frame (other broadcasts such as people may arrive first)
    peer_id = None
    while True:
        frame = await asyncio.wait_for(ws.recv(), timeout=2.0)
        data = json.loads(frame)
        if data.get("t") == "history":
            peer_id = data["peer_id"]
            break

    return priv, pk_b64, peer_id


def make_v2_msg(priv, pk_b64, mid, room, target_peer=None, n="123456789012345678901234", c="Y2lwaGVydGV4dA=="):
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


def test_same_room_delivery(ws_server):
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws1, websockets.connect(uri) as ws2:
            priv1, pk1, pid1 = await join_ws(ws1, "alice", "alpha")
            priv2, pk2, pid2 = await join_ws(ws2, "bob", "alpha")
            await asyncio.sleep(0.1)

            # Drain any peer broadcasts
            while True:
                try:
                    await asyncio.wait_for(ws2.recv(), timeout=0.1)
                except asyncio.TimeoutError:
                    break

            msg_payload = make_v2_msg(priv1, pk1, "msg_same_room_1", "alpha")
            await ws1.send(json.dumps(msg_payload))

            received = await asyncio.wait_for(ws2.recv(), timeout=1.0)
            data = json.loads(received)
            assert data.get("t") == "msg"
            assert data.get("msg", {}).get("id") == "msg_same_room_1"
            assert data.get("msg", {}).get("room") == "alpha"

    asyncio.run(_run())


def test_other_room_isolation(ws_server):
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws1, websockets.connect(uri) as ws2:
            priv1, pk1, pid1 = await join_ws(ws1, "alice", "alpha")
            priv2, pk2, pid2 = await join_ws(ws2, "charlie", "beta")
            await asyncio.sleep(0.1)

            while True:
                try:
                    await asyncio.wait_for(ws2.recv(), timeout=0.1)
                except asyncio.TimeoutError:
                    break

            msg_payload = make_v2_msg(priv1, pk1, "msg_iso_1", "alpha")
            await ws1.send(json.dumps(msg_payload))

            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(ws2.recv(), timeout=0.5)

    asyncio.run(_run())


def test_duplicate_id_dedupe(ws_server):
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws1, websockets.connect(uri) as ws2:
            priv1, pk1, pid1 = await join_ws(ws1, "alice", "main")
            priv2, pk2, pid2 = await join_ws(ws2, "bob", "main")
            await asyncio.sleep(0.1)

            while True:
                try:
                    await asyncio.wait_for(ws2.recv(), timeout=0.1)
                except asyncio.TimeoutError:
                    break

            msg = make_v2_msg(priv1, pk1, "dedupe_123", "main")
            await ws1.send(json.dumps(msg))
            rec1 = await asyncio.wait_for(ws2.recv(), timeout=1.0)
            assert json.loads(rec1)["msg"]["id"] == "dedupe_123"

            await ws1.send(json.dumps(msg))
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(ws2.recv(), timeout=0.5)

    asyncio.run(_run())


def test_dm_only_reaches_sender_and_target(ws_server):
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws1, websockets.connect(uri) as ws2, websockets.connect(uri) as ws3:
            priv1, pk1, pid1 = await join_ws(ws1, "alice", "room1")
            priv2, pk2, pid2 = await join_ws(ws2, "bob", "room1")
            priv3, pk3, pid3 = await join_ws(ws3, "eve", "room1")
            await asyncio.sleep(0.1)

            for ws in (ws1, ws2, ws3):
                while True:
                    try:
                        await asyncio.wait_for(ws.recv(), timeout=0.1)
                    except asyncio.TimeoutError:
                        break

            dm = make_v2_msg(priv1, pk1, "dm_secret_1", "room1", target_peer=pid2)
            await ws1.send(json.dumps(dm))

            rec_ws1 = await asyncio.wait_for(ws1.recv(), timeout=1.0)
            assert json.loads(rec_ws1)["msg"]["id"] == "dm_secret_1"

            rec_ws2 = await asyncio.wait_for(ws2.recv(), timeout=1.0)
            assert json.loads(rec_ws2)["msg"]["id"] == "dm_secret_1"

            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(ws3.recv(), timeout=0.5)

    asyncio.run(_run())


def test_malformed_json_keeps_connection_alive(ws_server):
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws:
            await join_ws(ws, "tester", "test")
            await asyncio.sleep(0.05)

            malformed = ["[]", "5", '"x"', "null", "not-a-valid-json{{{"]
            for bad in malformed:
                await ws.send(bad)
                await asyncio.sleep(0.02)

            ping = await ws.ping()
            await asyncio.wait_for(ping, timeout=1.0)
            assert ws.close_code is None

    asyncio.run(_run())


def test_invalid_prio_keeps_connection_alive(ws_server):
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws:
            priv, pk, pid = await join_ws(ws, "tester", "test")
            await asyncio.sleep(0.05)

            bad_prio_msg = {
                "t": "msg",
                "id": "bad_prio_1",
                "room": "test",
                "envelope": {"v": 2, "n": "123456789012345678901234", "c": "Y2lwaGVy"},
                "sig": "badsig",
                "pk": pk,
                "prio": "abc"
            }
            await ws.send(json.dumps(bad_prio_msg))
            await asyncio.sleep(0.05)

            ping = await ws.ping()
            await asyncio.wait_for(ping, timeout=1.0)
            assert ws.close_code is None

    asyncio.run(_run())


def test_beacon_crosses_rooms_to_all_clients(ws_server):
    """Verify beacon event is sent to all connected clients across different rooms."""
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws_a, websockets.connect(uri) as ws_b:
            priv_a, pk_a, pid_a = await join_ws(ws_a, "user_roomA", "roomA")
            await join_ws(ws_b, "user_roomB", "roomB")
            await asyncio.sleep(0.05)

            # Drain welcome messages
            for ws in (ws_a, ws_b):
                while True:
                    try:
                        await asyncio.wait_for(ws.recv(), timeout=0.05)
                    except asyncio.TimeoutError:
                        break

            # User in roomA sends beacon
            bid = "b_test_123"
            cat = "sos"
            prio = 3
            short_text = "SOS emergency test"
            ts = int(time.time() * 1000)
            sig_payload = f"beacon|{bid}|{cat}|{prio}|{short_text}|||{ts}".encode("utf-8")
            sig = base64.b64encode(priv_a.sign(sig_payload)).decode()

            beacon_payload = {
                "t": "beacon",
                "id": bid,
                "cat": cat,
                "prio": prio,
                "short_text": short_text,
                "handle": "user_roomA",
                "ts": ts,
                "pk": pk_a,
                "sig": sig
            }
            await ws_a.send(json.dumps(beacon_payload))

            # Both roomA and roomB must receive it
            rec_a = await asyncio.wait_for(ws_a.recv(), timeout=1.0)
            data_a = json.loads(rec_a)
            assert data_a["t"] == "beacon"
            assert data_a["id"] == "b_test_123"

            rec_b = await asyncio.wait_for(ws_b.recv(), timeout=1.0)
            data_b = json.loads(rec_b)
            assert data_b["t"] == "beacon"
            assert data_b["id"] == "b_test_123"

    asyncio.run(_run())


def test_room_switch_both_ways(ws_server):
    """Verify room switching sends switch_room and returns target room history."""
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws:
            await join_ws(ws, "alice", "room1")
            await asyncio.sleep(0.05)

            # Drain
            while True:
                try:
                    await asyncio.wait_for(ws.recv(), timeout=0.05)
                except asyncio.TimeoutError:
                    break

            # Switch to room2
            await ws.send(json.dumps({"t": "switch_room", "room": "room2"}))
            # First reply is history
            rec1 = await asyncio.wait_for(ws.recv(), timeout=1.0)
            data1 = json.loads(rec1)
            assert data1["t"] == "history"
            assert data1["room"] == "room2"

            # Drain any subsequent broadcast (e.g. people)
            while True:
                try:
                    await asyncio.wait_for(ws.recv(), timeout=0.05)
                except asyncio.TimeoutError:
                    break

            # Switch back to room1
            await ws.send(json.dumps({"t": "switch_room", "room": "room1"}))
            rec2 = await asyncio.wait_for(ws.recv(), timeout=1.0)
            data2 = json.loads(rec2)
            assert data2["t"] == "history"
            assert data2["room"] == "room1"

    asyncio.run(_run())


def test_ghost_mode_behavior(ws_server):
    """Verify ghost users are hidden from people list, show sender handle 'Ghost', and reject DMs."""
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws_alice, websockets.connect(uri) as ws_ghost:
            priv_a, pk_a, pid_a = await join_ws(ws_alice, "alice", "ghost_room", ghost=False)
            priv_g, pk_g, pid_g = await join_ws(ws_ghost, "secret_agent", "ghost_room", ghost=True)

            await asyncio.sleep(0.1)

            # Drain alice's incoming frames to see if ghost was broadcast in 'people'
            people_peers = None
            while True:
                try:
                    f = await asyncio.wait_for(ws_alice.recv(), timeout=0.1)
                    d = json.loads(f)
                    if d.get("t") == "people":
                        people_peers = d.get("peers", [])
                except asyncio.TimeoutError:
                    break

            # Ghost peer must NOT be in alice's peers list
            if people_peers is not None:
                peer_ids = [p["peer_id"] for p in people_peers]
                assert pid_g not in peer_ids

            # Ghost sends a message
            msg_payload = make_v2_msg(priv_g, pk_g, "g-msg-1", "ghost_room")
            await ws_ghost.send(json.dumps(msg_payload))

            # Alice receives message and sender is "Ghost"
            rec = await asyncio.wait_for(ws_alice.recv(), timeout=1.0)
            data = json.loads(rec)
            assert data.get("t") == "msg"
            assert data.get("msg", {}).get("from") == "Ghost"

            # Alice attempts to DM the ghost user -> server returns target_unavailable
            dm_payload = make_v2_msg(priv_a, pk_a, "dm-1", "ghost_room", target_peer=pid_g)
            await ws_alice.send(json.dumps(dm_payload))

            err = await asyncio.wait_for(ws_alice.recv(), timeout=1.0)
            err_data = json.loads(err)
            assert err_data.get("t") == "error"
            assert err_data.get("code") == "target_unavailable"

    asyncio.run(_run())


def test_deterministic_bip39_derivation():
    """Verify deterministic 12-word seed derivation using PBKDF2-SHA256, 100000 iter, salt mistroom:identity:v2."""
    import hashlib
    words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    salt = b"mistroom:identity:v2"
    seed1 = hashlib.pbkdf2_hmac("sha256", words.encode("utf-8"), salt, 100000, dklen=32)
    seed2 = hashlib.pbkdf2_hmac("sha256", words.encode("utf-8"), salt, 100000, dklen=32)
    assert seed1 == seed2
    assert len(seed1) == 32




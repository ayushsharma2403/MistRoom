import asyncio
import base64
import json
import threading
import time
import pytest
import uvicorn
import websockets
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from backend.state import clients, seen_ids, history, active_beacons, peer_beacon_times


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
    port = 3095
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
    active_beacons.clear()
    peer_beacon_times.clear()
    yield
    clients.clear()
    seen_ids.clear()
    history.clear()
    active_beacons.clear()
    peer_beacon_times.clear()


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


def make_signed_beacon(priv, pk_b64, bid, cat="sos", prio=3, short_text="Emergency test", lat=12.34, lon=56.78, ts=None, handle=None):
    if ts is None:
        ts = int(time.time() * 1000)
    lat_str = str(lat) if lat is not None else ""
    lon_str = str(lon) if lon is not None else ""
    sig_payload = f"beacon|{bid}|{cat}|{prio}|{short_text}|{lat_str}|{lon_str}|{ts}".encode("utf-8")
    sig = base64.b64encode(priv.sign(sig_payload)).decode()
    payload = {
        "t": "beacon",
        "id": bid,
        "cat": cat,
        "prio": prio,
        "short_text": short_text,
        "lat": lat,
        "lon": lon,
        "ts": ts,
        "pk": pk_b64,
        "sig": sig
    }
    if handle:
        payload["handle"] = handle
    return payload


@pytest.mark.asyncio
async def test_lat_out_of_bounds_rejected(ws_server):
    async with websockets.connect(ws_server, origin="http://127.0.0.1:3095") as ws:
        priv, pk, pid, _ = await join_client(ws, "Alice")
        beacon = make_signed_beacon(priv, pk, "b_lat_invalid", lat=9999.0)
        await ws.send(json.dumps(beacon))

        res = await recv_until(ws, {"error"})
        assert res.get("code") in ("bad_frame", "bad_beacon")


@pytest.mark.asyncio
async def test_forged_handle_ignored(ws_server):
    async with websockets.connect(ws_server, origin="http://127.0.0.1:3095") as ws_sender, \
               websockets.connect(ws_server, origin="http://127.0.0.1:3095") as ws_receiver:
        priv1, pk1, pid1, _ = await join_client(ws_sender, "LegitName")
        _, _, _, _ = await join_client(ws_receiver, "Receiver")

        beacon = make_signed_beacon(priv1, pk1, "b_forged", handle="AdminForged")
        await ws_sender.send(json.dumps(beacon))

        res = await recv_until(ws_receiver, {"beacon"})
        assert res.get("handle") == "LegitName"
        assert res.get("handle") != "AdminForged"


@pytest.mark.asyncio
async def test_max_100_beacons_and_joiner_payload_size(ws_server):
    # Populate active_beacons with 150 items
    now = int(time.time() * 1000)
    for i in range(150):
        bid = f"b_mass_{i}"
        active_beacons[bid] = {
            "t": "beacon",
            "id": bid,
            "cat": "sos",
            "prio": 3,
            "short_text": f"Emergency beacon number {i}",
            "lat": 10.0,
            "lon": 20.0,
            "handle": "Sender",
            "peer_id": "testpeer",
            "ts": now - (150 - i) * 100,  # incremental timestamps
            "pk": "pk",
            "sig": "sig"
        }

    # Connect a new client and join
    async with websockets.connect(ws_server, origin="http://127.0.0.1:3095") as ws:
        priv, pk, pid, history_data = await join_client(ws, "Bob")
        # Assert active_beacons pruned to max 100 on join
        assert len(active_beacons) <= 100
        # Assert history message sent to joiner is < 20 KB
        raw_history_payload = json.dumps(history_data)
        assert len(raw_history_payload.encode("utf-8")) < 20 * 1024

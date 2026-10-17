"""WebSocket regression tests for MistRoom."""
import asyncio
import json
import threading
import time
import pytest
import uvicorn
import websockets
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


def test_same_room_delivery(ws_server):
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws1, websockets.connect(uri) as ws2:
            await ws1.send(json.dumps({"t": "join", "name": "alice", "peer_id": "p1", "room": "alpha"}))
            await ws2.send(json.dumps({"t": "join", "name": "bob", "peer_id": "p2", "room": "alpha"}))
            await asyncio.sleep(0.1)

            while True:
                try:
                    await asyncio.wait_for(ws2.recv(), timeout=0.1)
                except asyncio.TimeoutError:
                    break

            msg_payload = {
                "t": "msg",
                "id": "msg_same_room_1",
                "text": "hello alpha",
                "ciphertext": "cipher1",
                "iv": "iv1"
            }
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
            await ws1.send(json.dumps({"t": "join", "name": "alice", "peer_id": "p1", "room": "alpha"}))
            await ws2.send(json.dumps({"t": "join", "name": "charlie", "peer_id": "p3", "room": "beta"}))
            await asyncio.sleep(0.1)

            while True:
                try:
                    await asyncio.wait_for(ws2.recv(), timeout=0.1)
                except asyncio.TimeoutError:
                    break

            msg_payload = {
                "t": "msg",
                "id": "msg_iso_1",
                "text": "secret in alpha",
                "ciphertext": "cipher1",
                "iv": "iv1"
            }
            await ws1.send(json.dumps(msg_payload))

            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(ws2.recv(), timeout=0.5)

    asyncio.run(_run())


def test_duplicate_id_dedupe(ws_server):
    async def _run():
        uri = ws_server
        async with websockets.connect(uri) as ws1, websockets.connect(uri) as ws2:
            await ws1.send(json.dumps({"t": "join", "name": "alice", "peer_id": "p1", "room": "main"}))
            await ws2.send(json.dumps({"t": "join", "name": "bob", "peer_id": "p2", "room": "main"}))
            await asyncio.sleep(0.1)

            while True:
                try:
                    await asyncio.wait_for(ws2.recv(), timeout=0.1)
                except asyncio.TimeoutError:
                    break

            msg = {"t": "msg", "id": "dedupe_123", "text": "once", "ciphertext": "c1", "iv": "i1"}
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
            await ws1.send(json.dumps({"t": "join", "name": "alice", "peer_id": "p1", "room": "room1"}))
            await ws2.send(json.dumps({"t": "join", "name": "bob", "peer_id": "p2", "room": "room1"}))
            await ws3.send(json.dumps({"t": "join", "name": "eve", "peer_id": "p3", "room": "room1"}))
            await asyncio.sleep(0.1)

            for ws in (ws1, ws2, ws3):
                while True:
                    try:
                        await asyncio.wait_for(ws.recv(), timeout=0.1)
                    except asyncio.TimeoutError:
                        break

            dm = {
                "t": "msg",
                "id": "dm_secret_1",
                "text": "for bob eyes only",
                "target_peer": "p2",
                "ciphertext": "c_dm",
                "iv": "i_dm"
            }
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
            await ws.send(json.dumps({"t": "join", "name": "tester", "peer_id": "ptest", "room": "test"}))
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
            await ws.send(json.dumps({"t": "join", "name": "tester", "peer_id": "ptest", "room": "test"}))
            await asyncio.sleep(0.05)

            bad_prio_msg = {
                "t": "msg",
                "id": "bad_prio_1",
                "cat": "general",
                "prio": "abc",
                "text": "hello with weird prio"
            }
            await ws.send(json.dumps(bad_prio_msg))
            await asyncio.sleep(0.05)

            ping = await ws.ping()
            await asyncio.wait_for(ping, timeout=1.0)
            assert ws.close_code is None

    asyncio.run(_run())

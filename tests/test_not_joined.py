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
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", ws_max_size=65536))

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


@pytest.mark.asyncio
async def test_unjoined_client_gets_not_joined_error(ws_server):
    async with websockets.connect(ws_server, origin="http://127.0.0.1:3097") as ws:
        # First message from server is challenge
        challenge_raw = await ws.recv()
        challenge_data = json.loads(challenge_raw)
        assert challenge_data.get("t") == "challenge"

        # Now send various events without joining
        unjoined_payloads = [
            {"t": "beacon", "id": "b1", "text": "Help needed"},
            {"t": "need_resolved", "id": "n1"},
            {"t": "msg", "id": "m1", "text": "hello"},
            {"t": "webrtc_offer", "target": "peerX", "data": {}},
            {"t": "call_invite", "target": "peerY", "data": {}},
        ]

        for payload in unjoined_payloads:
            await ws.send(json.dumps(payload))
            res_raw = await ws.recv()
            res = json.loads(res_raw)
            assert res.get("t") == "error", f"Expected error for payload {payload}, got {res}"
            assert res.get("code") == "not_joined", f"Expected not_joined for payload {payload}, got {res}"

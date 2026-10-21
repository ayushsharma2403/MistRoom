"""MistRoom WebSocket benchmark tool.
Tests N concurrent websocket connections (50, 100, 200).
Measures total join time and fanout latency with v2 signed join and envelopes.
Outputs JSON results.
"""
import asyncio
import base64
import json
import sys
import threading
import time
from pathlib import Path

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import uvicorn
import websockets
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

SERVER_PORT = 3105
SERVER_URI = f"ws://127.0.0.1:{SERVER_PORT}/ws"


class ServerThread(threading.Thread):
    def __init__(self, app, port):
        super().__init__(daemon=True)
        self.port = port
        self.server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", ws_max_size=65536)
        )

    def run(self):
        self.server.run()

    def stop(self):
        self.server.should_exit = True


async def join_client_v2(ws, name: str, room: str = "benchmark"):
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key()
    pk_bytes = pub.public_bytes_raw()
    pk_b64 = base64.b64encode(pk_bytes).decode()

    frame = await asyncio.wait_for(ws.recv(), timeout=5.0)
    data = json.loads(frame)
    if data.get("t") != "challenge":
        raise ValueError(f"Expected challenge frame, got: {data}")
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
        frame = await asyncio.wait_for(ws.recv(), timeout=5.0)
        data = json.loads(frame)
        if data.get("t") == "history":
            peer_id = data["peer_id"]
            break
        if data.get("t") == "error":
            raise ValueError(f"Join error: {data}")

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


async def client_worker(
    client_id: int,
    uri: str,
    barrier: asyncio.Event,
    received_events: list,
    stop_event: asyncio.Event,
    target_msg_id: str
):
    try:
        async with websockets.connect(uri, max_size=65536) as ws:
            await join_client_v2(ws, name=f"bench{client_id}", room="benchmark")
            barrier.set()

            while not stop_event.is_set():
                try:
                    msg_raw = await asyncio.wait_for(ws.recv(), timeout=0.2)
                    data = json.loads(msg_raw)
                    if data.get("t") == "msg" and data.get("msg", {}).get("id") == target_msg_id:
                        recv_time = time.perf_counter()
                        received_events.append((client_id, recv_time))
                except asyncio.TimeoutError:
                    continue
                except Exception:
                    break
    except Exception:
        pass


async def run_benchmark(n_clients: int, uri: str = SERVER_URI):
    start_join = time.perf_counter()
    stop_event = asyncio.Event()
    received_events = []
    ready_flags = [asyncio.Event() for _ in range(n_clients)]
    target_msg_id = "bench_fanout_msg"

    tasks = [
        asyncio.create_task(client_worker(i, uri, ready_flags[i], received_events, stop_event, target_msg_id))
        for i in range(n_clients)
    ]

    try:
        await asyncio.wait_for(asyncio.gather(*(f.wait() for f in ready_flags)), timeout=60.0)
    except asyncio.TimeoutError:
        pass

    total_join_time = time.perf_counter() - start_join
    joined_count = sum(1 for f in ready_flags if f.is_set())

    # Send fanout message from a dedicated sender
    send_timestamp = time.perf_counter()
    try:
        async with websockets.connect(uri, max_size=65536) as sender_ws:
            priv, pk_b64, _ = await join_client_v2(sender_ws, name="sender", room="benchmark")
            await asyncio.sleep(0.05)

            msg_payload = make_v2_envelope_msg(priv, pk_b64, mid=target_msg_id, room="benchmark")
            send_timestamp = time.perf_counter()
            await sender_ws.send(json.dumps(msg_payload))

            # Wait for propagation
            await asyncio.sleep(1.0)
    except Exception:
        pass

    stop_event.set()
    await asyncio.gather(*tasks, return_exceptions=True)

    latencies = [(recv_ts - send_timestamp) * 1000 for _, recv_ts in received_events if recv_ts >= send_timestamp]

    result = {
        "clients": n_clients,
        "joined": joined_count,
        "join_time_s": round(total_join_time, 3),
        "fanout_delivered": len(received_events),
        "latency_min_ms": round(min(latencies), 2) if latencies else None,
        "latency_avg_ms": round(sum(latencies) / len(latencies), 2) if latencies else None,
        "latency_max_ms": round(max(latencies), 2) if latencies else None,
    }
    return result


async def main():
    scenarios = [50, 100, 200]
    results = []

    # Check if a server is already running on SERVER_PORT or 3001
    server_thread = None
    target_uri = SERVER_URI

    # Attempt connecting to existing server or start in-process server
    try:
        async with websockets.connect("ws://127.0.0.1:3001/ws", open_timeout=0.5):
            target_uri = "ws://127.0.0.1:3001/ws"
    except Exception:
        from backend.server import app
        server_thread = ServerThread(app, SERVER_PORT)
        server_thread.start()
        time.sleep(1.0)
        target_uri = SERVER_URI

    try:
        for n in scenarios:
            res = await run_benchmark(n, uri=target_uri)
            results.append(res)
            await asyncio.sleep(0.5)

        print(json.dumps(results, indent=2))
    finally:
        if server_thread:
            server_thread.stop()


if __name__ == "__main__":
    asyncio.run(main())

"""MistRoom WebSocket benchmark tool.
Tests N concurrent websocket connections (25, 100, 200, 400).
Measures total join time and fanout latency.
"""
import asyncio
import json
import time
import websockets

SERVER_URI = "ws://127.0.0.1:3001/ws"


async def client_worker(client_id: int, uri: str, barrier: asyncio.Event, received_events: list, stop_event: asyncio.Event):
    async with websockets.connect(uri) as ws:
        peer_id = f"bench_peer_{client_id}"
        join_payload = {
            "t": "join",
            "name": f"bench_{client_id}",
            "peer_id": peer_id,
            "room": "benchmark"
        }
        await ws.send(json.dumps(join_payload))

        # Signal ready
        barrier.set()

        while not stop_event.is_set():
            try:
                msg_raw = await asyncio.wait_for(ws.recv(), timeout=0.2)
                data = json.loads(msg_raw)
                if data.get("t") == "msg" and data.get("msg", {}).get("id") == "bench_fanout_msg":
                    recv_time = time.perf_counter()
                    received_events.append((client_id, recv_time))
            except asyncio.TimeoutError:
                continue
            except Exception:
                break


async def run_benchmark(n_clients: int, uri: str = SERVER_URI):
    print(f"\n--- Running benchmark with {n_clients} WebSocket clients ---")
    start_join = time.perf_counter()
    stop_event = asyncio.Event()
    received_events = []
    ready_flags = [asyncio.Event() for _ in range(n_clients)]

    tasks = []
    for i in range(n_clients):
        t = asyncio.create_task(client_worker(i, uri, ready_flags[i], received_events, stop_event))
        tasks.append(t)

    # Wait for all clients to connect and join
    try:
        await asyncio.wait_for(asyncio.gather(*(f.wait() for f in ready_flags)), timeout=15.0)
    except asyncio.TimeoutError:
        print(f"Warning: Only {sum(1 for f in ready_flags if f.is_set())}/{n_clients} clients joined before timeout.")

    total_join_time = time.perf_counter() - start_join
    print(f"Total Join Time: {total_join_time*1000:.2f} ms ({total_join_time:.3f} s)")

    # Send fanout message from a dedicated sender
    async with websockets.connect(uri) as sender_ws:
        await sender_ws.send(json.dumps({
            "t": "join", "name": "bench_sender", "peer_id": "bench_sender", "room": "benchmark"
        }))
        await asyncio.sleep(0.1)

        send_timestamp = time.perf_counter()
        await sender_ws.send(json.dumps({
            "t": "msg",
            "id": "bench_fanout_msg",
            "text": "benchmark payload",
            "ciphertext": "bench_cipher",
            "iv": "bench_iv"
        }))

        # Wait for messages to propagate
        await asyncio.sleep(1.0)

    stop_event.set()
    await asyncio.gather(*tasks, return_exceptions=True)

    if received_events:
        latencies = [(recv_ts - send_timestamp) * 1000 for _, recv_ts in received_events]
        avg_lat = sum(latencies) / len(latencies)
        max_lat = max(latencies)
        min_lat = min(latencies)
        print(f"Fanout Delivered: {len(received_events)}/{n_clients} clients")
        print(f"Latency -> Min: {min_lat:.2f} ms | Avg: {avg_lat:.2f} ms | Max: {max_lat:.2f} ms")
    else:
        print("No fanout messages received.")


async def main():
    concurrency_levels = [25, 100, 200, 400]
    for n in concurrency_levels:
        try:
            await run_benchmark(n)
        except Exception as e:
            print(f"Benchmark error for {n} clients: {e}")
            break


if __name__ == "__main__":
    asyncio.run(main())

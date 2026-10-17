"""State and shared persistence layer for MistRoom."""
import json
from collections import deque
from typing import Optional
from fastapi import WebSocket
from backend.config import (
    MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
)

db_pool = None
clients: dict[WebSocket, dict] = {}
seen_ids: deque = deque(maxlen=2000)
history: deque = deque(maxlen=100)


async def init_db():
    global db_pool
    if not MYSQL_HOST:
        print("[DB] Running in resilient in-memory mode (No MYSQL_HOST configured).")
        return
    try:
        import aiomysql
        db_pool = await aiomysql.create_pool(
            host=MYSQL_HOST,
            port=MYSQL_PORT,
            user=MYSQL_USER,
            password=MYSQL_PASSWORD,
            db=MYSQL_DATABASE,
            autocommit=True,
            minsize=1,
            maxsize=10,
        )
        print(f"[DB] Connected to MySQL at {MYSQL_HOST}:{MYSQL_PORT}")
    except Exception as e:
        print(f"[DB Warning] Could not connect to MySQL ({e}). Using in-memory mode.")
        db_pool = None


async def close_db():
    global db_pool
    if db_pool:
        db_pool.close()
        await db_pool.wait_closed()


async def db_save_peer(peer_id: str, nickname: str):
    if not db_pool:
        return
    try:
        async with db_pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """INSERT INTO active_peers (peer_id, room_id, nickname)
                       VALUES (%s, 'default', %s)
                       ON DUPLICATE KEY UPDATE nickname=%s, last_seen=CURRENT_TIMESTAMP""",
                    (peer_id, nickname, nickname)
                )
    except Exception as e:
        print(f"[DB Error] db_save_peer: {e}")


async def db_remove_peer(peer_id: str):
    if not db_pool:
        return
    try:
        async with db_pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("DELETE FROM active_peers WHERE peer_id=%s", (peer_id,))
    except Exception as e:
        print(f"[DB Error] db_remove_peer: {e}")


async def db_save_message(mid: str, sender: str, ciphertext: str, iv: str, cat: str, prio: int):
    """Zero-knowledge storage: strictly saves ciphertext + iv, never stores plaintext or IPs."""
    if not db_pool:
        return
    try:
        async with db_pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """INSERT IGNORE INTO ephemeral_messages (id, room_id, sender, ciphertext, iv, cat, prio)
                       VALUES (%s, 'default', %s, %s, %s, %s, %s)""",
                    (mid, sender, ciphertext, iv, cat, prio)
                )
    except Exception as e:
        print(f"[DB Error] db_save_message: {e}")


async def send_json(ws: WebSocket, payload: dict):
    try:
        await ws.send_text(json.dumps(payload))
    except Exception:
        clients.pop(ws, None)


async def broadcast_json(payload: dict, exclude: Optional[WebSocket] = None):
    for ws in list(clients):
        if ws != exclude:
            await send_json(ws, payload)


async def broadcast_peers():
    for ws_client, c in list(clients.items()):
        current_room = c.get("room", "global")
        all_rooms = list({cl.get("room", "global") for cl in clients.values() if cl.get("name")})
        room_peers = [
            {"name": other["name"], "peer_id": other["peer_id"], "room": other.get("room", "global")}
            for other in clients.values() if other.get("name") and other.get("room", "global") == current_room
        ]
        await send_json(ws_client, {
            "t": "people",
            "people": room_peers,
            "room": current_room,
            "available_rooms": all_rooms
        })

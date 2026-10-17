"""In-memory state and messaging relay for MistRoom."""
import json
from collections import deque
from typing import Optional
from fastapi import WebSocket

clients: dict[WebSocket, dict] = {}
seen_ids: deque = deque(maxlen=2000)
history: deque = deque(maxlen=100)


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

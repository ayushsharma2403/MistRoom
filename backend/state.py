"""In-memory state and messaging relay for MistRoom."""
import json
import time
from collections import deque, Counter
from typing import Optional
from fastapi import WebSocket

clients: dict[WebSocket, dict] = {}
seen_ids: deque = deque(maxlen=2000)
history: deque = deque(maxlen=100)

ip_connections: Counter = Counter()

RESERVED_HANDLES = {"admin", "system", "police", "anonymous"}


def format_displayed_handle(nickname: str, peer_id: str, room: str) -> str:
    room_matches = [
        c for c in clients.values()
        if c.get("room") == room and c.get("name") and c["name"].lower() == nickname.lower()
    ]
    if len(room_matches) > 1:
        suffix = peer_id[:4] if peer_id else "0000"
        return f"{nickname}#{suffix}"
    return nickname


async def send_json(ws: WebSocket, payload: dict):
    try:
        await ws.send_text(json.dumps(payload))
    except Exception:
        clients.pop(ws, None)


async def broadcast_peers():
    for ws_client, c in list(clients.items()):
        current_room = c.get("room", "global")
        all_rooms = list({cl.get("room", "global") for cl in clients.values() if cl.get("name")})

        room_clients = [
            cl for cl in clients.values()
            if cl.get("name") and cl.get("room", "global") == current_room
        ]

        # Calculate counts of nicknames in room to append #prefix if shared
        name_counts = Counter(cl["name"].lower() for cl in room_clients)

        room_peers = []
        for other in room_clients:
            display_name = other["name"]
            if name_counts[other["name"].lower()] > 1:
                display_name = f"{other['name']}#{other['peer_id'][:4]}"
            room_peers.append({
                "name": display_name,
                "peer_id": other["peer_id"],
                "room": other.get("room", "global"),
                "pk": other.get("pk", "")
            })

        await send_json(ws_client, {
            "t": "people",
            "people": room_peers,
            "room": current_room,
            "available_rooms": all_rooms
        })

"""In-memory state and messaging relay for MistRoom."""
import json
import time
from collections import deque, Counter
from typing import Optional
from fastapi import WebSocket

clients: dict[WebSocket, dict] = {}
seen_ids: deque = deque(maxlen=2000)
# Per-room history dict (room -> deque(maxlen=100))
room_histories: dict[str, deque] = {}
# Active public beacons
active_beacons: dict[str, dict] = {}


class GlobalHistoryProxy:
    """Proxy for backward compatibility with tests expecting history.clear() or list access."""
    def clear(self):
        room_histories.clear()

    def __iter__(self):
        for h in room_histories.values():
            yield from h

    def __len__(self):
        return sum(len(h) for h in room_histories.values())


history = GlobalHistoryProxy()

ip_connections: Counter = Counter()

RESERVED_HANDLES = {"admin", "system", "police", "anonymous"}


def get_room_history(room: str) -> deque:
    if room not in room_histories:
        room_histories[room] = deque(maxlen=100)
    return room_histories[room]


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
    # Room list with live peer counts; room names come only from rooms with at least 1 non-ghost peer
    active_room_counts = Counter(
        cl.get("room", "global") for cl in clients.values()
        if cl.get("name") and not cl.get("ghost", False)
    )
    available_rooms_with_counts = [
        {"room": r, "count": count} for r, count in active_room_counts.items() if count > 0
    ]
    # Simple list of room names for clients
    available_room_names = [r["room"] for r in available_rooms_with_counts]

    for ws_client, c in list(clients.items()):
        current_room = c.get("room", "global")

        # Exclude ghost clients from people list
        room_clients = [
            cl for cl in clients.values()
            if cl.get("name") and cl.get("room", "global") == current_room and not cl.get("ghost", False)
        ]

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
            "available_rooms": available_room_names,
            "rooms_info": available_rooms_with_counts
        })

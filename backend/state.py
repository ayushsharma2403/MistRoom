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
peer_beacon_times: dict[str, deque] = {}
peer_call_times: dict[str, deque] = {}
need_owners: dict[str, str] = {}
_last_beacon_cleanup: float = 0.0


def cleanup_expired_beacons(force: bool = False):
    global _last_beacon_cleanup
    now_ms = time.time() * 1000
    now_sec = now_ms / 1000
    if not force and (now_sec - _last_beacon_cleanup < 60):
        return
    _last_beacon_cleanup = now_sec
    cutoff = now_ms - (2 * 3600 * 1000)  # 2 hours in ms
    expired_ids = [
        bid for bid, b in active_beacons.items()
        if (b.get("ts") or 0) < cutoff
    ]
    for bid in expired_ids:
        active_beacons.pop(bid, None)

    if len(active_beacons) > 100:
        sorted_beacons = sorted(
            active_beacons.items(),
            key=lambda item: item[1].get("ts") or 0,
            reverse=True
        )
        active_beacons.clear()
        for k, v in sorted_beacons[:100]:
            active_beacons[k] = v


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

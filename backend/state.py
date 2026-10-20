"""In-memory state and messaging relay for MistRoom."""
import json
import time
from collections import deque, Counter
from typing import Optional
from fastapi import WebSocket

clients: dict[WebSocket, dict] = {}
seen_ids: dict[str, dict[str, float]] = {}
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

import unicodedata

RESERVED_HANDLES = {"admin", "system", "police", "anonymous", "ghost", "moderator"}

_ZERO_WIDTH_CHARS = {'\u200b', '\u200c', '\u200d', '\ufeff', '\u200e', '\u200f'}

def normalize_handle(name: str) -> str:
    # 1. Normalize with NFKC
    n = unicodedata.normalize("NFKC", name)
    # 2. Strip spaces and zero-width chars
    n = "".join(c for c in n if not c.isspace() and c not in _ZERO_WIDTH_CHARS)
    # 3. Casefold
    n = n.casefold()
    # 4. Fold 0->o, 1->i (or l), rn->m
    # In handles like Adm1n, 1 represents i; in others like p0l1ce, 1 represents l/i.
    n = n.replace("rn", "m")
    trans = str.maketrans({"0": "o", "1": "i"})
    n = n.translate(trans)
    # Also handle l -> i folding for matching admin / police
    n = n.replace("l", "i")
    return n

def is_reserved_handle(name: str, allow_anonymous: bool = False) -> bool:
    norm = normalize_handle(name)
    if allow_anonymous and norm == normalize_handle("anonymous"):
        return False
    # Compare against normalized reserved set
    normalized_reserved = {normalize_handle(h) for h in RESERVED_HANDLES}
    return norm in normalized_reserved


def is_seen_id(room: str, msg_id: str) -> bool:
    room_seen = seen_ids.get(room)
    if not room_seen:
        return False
    ts = room_seen.get(msg_id)
    if ts is None:
        return False
    if time.time() - ts > 600:
        room_seen.pop(msg_id, None)
        return False
    return True


def record_seen_id(room: str, msg_id: str, ts: Optional[float] = None):
    now = time.time()
    if ts is None:
        ts = now
    if room not in seen_ids:
        seen_ids[room] = {}
    room_seen = seen_ids[room]
    expired = [k for k, v in room_seen.items() if now - v > 600]
    for k in expired:
        room_seen.pop(k, None)
    room_seen[msg_id] = ts


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

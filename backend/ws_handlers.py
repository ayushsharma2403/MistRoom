"""WebSocket event handlers and v2 protocol validation for MistRoom."""
import base64
import hashlib
import re
import time
from typing import Optional, Literal
from fastapi import WebSocket
from pydantic import BaseModel, Field, ValidationError

from backend.state import (
    clients, seen_ids, history, send_json, broadcast_peers,
    RESERVED_HANDLES, format_displayed_handle
)

B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"


def bytes_to_base32(data: bytes) -> str:
    bits = 0
    val = 0
    output = []
    for b in data:
        val = (val << 8) | b
        bits += 8
        while bits >= 5:
            output.append(B32_ALPHABET[(val >> (bits - 5)) & 31])
            bits -= 5
    if bits > 0:
        output.append(B32_ALPHABET[(val << (5 - bits)) & 31])
    return "".join(output)


def derive_peer_id_from_pk(pk_b64: str) -> Optional[str]:
    try:
        pk_bytes = base64.b64decode(pk_b64)
        if len(pk_bytes) != 32:
            return None
        h = hashlib.sha256(pk_bytes).digest()
        return bytes_to_base32(h[:16])
    except Exception:
        return None


def verify_ed25519_sig(pk_b64: str, sig_b64: str, data_bytes: bytes) -> bool:
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        pk_bytes = base64.b64decode(pk_b64)
        sig_bytes = base64.b64decode(sig_b64)
        pub_key = Ed25519PublicKey.from_public_bytes(pk_bytes)
        pub_key.verify(sig_bytes, data_bytes)
        return True
    except Exception:
        return False


# -------------------------------------------------------------
# PYDANTIC INBOUND SCHEMAS
# -------------------------------------------------------------
class JoinModel(BaseModel):
    t: Literal["join"]
    name: str = Field(min_length=1, max_length=20)
    room: str = Field(default="global", min_length=1, max_length=30)
    pk: str
    sig: str


class SwitchRoomModel(BaseModel):
    t: Literal["switch_room"]
    room: str = Field(min_length=1, max_length=30)


class EnvelopeModel(BaseModel):
    v: Literal[2]
    n: str = Field(min_length=1)
    c: str = Field(min_length=1)


class MsgModel(BaseModel):
    t: Literal["msg"]
    id: str = Field(min_length=1, max_length=64)
    room: str = Field(min_length=1, max_length=30)
    envelope: EnvelopeModel
    sig: str = Field(min_length=1)
    pk: str = Field(min_length=1)
    target_peer: Optional[str] = Field(default=None, max_length=64)
    cat: Optional[str] = Field(default="general", max_length=32)
    prio: Optional[int] = Field(default=0, ge=0, le=3)
    text: Optional[str] = None


class MsgAckModel(BaseModel):
    t: Literal["msg_ack"]
    id: str = Field(min_length=1, max_length=64)
    target_peer: str = Field(min_length=1, max_length=64)
    status: Optional[str] = Field(default="delivered", max_length=20)


class SignalingModel(BaseModel):
    t: Literal["webrtc_offer", "webrtc_answer", "webrtc_ice",
               "call_invite", "call_accept", "call_decline",
               "call_hangup", "call_ice", "p2p_file"]
    target: Optional[str] = Field(default=None, max_length=64)
    data: Optional[dict] = None


NAME_REGEX = re.compile(r"^[\w\- ]+$", re.UNICODE)


async def handle_join_v2(ws: WebSocket, msg_data: dict, challenge_nonce: str):
    try:
        parsed = JoinModel(**msg_data)
    except ValidationError:
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    name = parsed.name.strip()
    room = parsed.room.strip()

    if not NAME_REGEX.match(name) or not NAME_REGEX.match(room):
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    # Never allow reserved handles except Ghost mode's own rename ("Anonymous")
    if name.lower() in {"admin", "system", "police"}:
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    peer_id = derive_peer_id_from_pk(parsed.pk)
    if not peer_id:
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    nonce_bytes = base64.b64decode(challenge_nonce)
    if not verify_ed25519_sig(parsed.pk, parsed.sig, nonce_bytes):
        await send_json(ws, {"t": "error", "code": "bad_signature"})
        return

    # Check for existing connection with same peer_id (anti-hijacking: replace old)
    for other_ws, info in list(clients.items()):
        if other_ws != ws and info.get("peer_id") == peer_id:
            try:
                await other_ws.close(code=1000, reason="Replaced by new connection")
            except Exception:
                pass
            clients.pop(other_ws, None)

    clients[ws]["name"] = name
    clients[ws]["peer_id"] = peer_id
    clients[ws]["room"] = room
    clients[ws]["pk"] = parsed.pk

    # Filter room history (never include DMs)
    room_history = [
        m for m in history
        if m.get("room", "global") == room and not m.get("target_peer")
    ]

    await send_json(ws, {
        "t": "history",
        "history": room_history,
        "peer_id": peer_id,
        "room": room
    })
    await broadcast_peers()


async def handle_switch_room_v2(ws: WebSocket, msg_data: dict):
    try:
        parsed = SwitchRoomModel(**msg_data)
    except ValidationError:
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    new_room = parsed.room.strip()
    if not NAME_REGEX.match(new_room):
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    clients[ws]["room"] = new_room
    room_history = [
        m for m in history
        if m.get("room", "global") == new_room and not m.get("target_peer")
    ]
    await send_json(ws, {
        "t": "history",
        "history": room_history,
        "peer_id": clients[ws]["peer_id"],
        "room": new_room
    })
    await broadcast_peers()


async def handle_msg_v2(ws: WebSocket, msg_data: dict):
    if not clients.get(ws, {}).get("name"):
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    # Reject msg frames containing a plaintext text field
    if "text" in msg_data and msg_data["text"] is not None:
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    try:
        parsed = MsgModel(**msg_data)
    except ValidationError:
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    mid = parsed.id
    if mid in seen_ids:
        return
    seen_ids.append(mid)

    # Verify signature over (room|id|ts|n|c)
    ts = int(time.time() * 1000)
    sig_payload = f"{parsed.room}|{mid}|{msg_data.get('ts', ts)}|{parsed.envelope.n}|{parsed.envelope.c}".encode()
    if not verify_ed25519_sig(parsed.pk, parsed.sig, sig_payload):
        await send_json(ws, {"t": "error", "code": "bad_signature"})
        return

    sender_peer_id = clients[ws]["peer_id"]
    derived_from_pk = derive_peer_id_from_pk(parsed.pk)
    if derived_from_pk != sender_peer_id:
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    current_room = clients[ws]["room"]
    display_name = format_displayed_handle(clients[ws]["name"], sender_peer_id, current_room)

    record = {
        "id": mid,
        "from": display_name,
        "peer_id": sender_peer_id,
        "room": current_room,
        "envelope": parsed.envelope.model_dump(),
        "sig": parsed.sig,
        "pk": parsed.pk,
        "ts": msg_data.get("ts", ts),
        "cat": parsed.cat or "general",
        "prio": parsed.prio if parsed.prio is not None else 0
    }

    if parsed.target_peer:
        record["target_peer"] = parsed.target_peer
        record["is_dm"] = True
        # Deliver only to sender and target; never store in history
        for client_ws, client_info in list(clients.items()):
            if client_info.get("peer_id") in (parsed.target_peer, sender_peer_id):
                await send_json(client_ws, {"t": "msg", "msg": record})
    else:
        # Normal room message: append to history and broadcast to current room peers only
        history.append(record)
        for client_ws, client_info in list(clients.items()):
            if client_info.get("room") == current_room:
                await send_json(client_ws, {"t": "msg", "msg": record})


async def handle_msg_ack_v2(ws: WebSocket, msg_data: dict):
    try:
        parsed = MsgAckModel(**msg_data)
    except ValidationError:
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    target = parsed.target_peer
    sender_pid = clients[ws]["peer_id"]
    for client_ws, client_info in list(clients.items()):
        if client_info.get("peer_id") == target:
            await send_json(client_ws, {
                "t": "msg_ack",
                "id": parsed.id,
                "from_peer": sender_pid,
                "status": parsed.status or "delivered"
            })


async def handle_signaling_v2(ws: WebSocket, msg_data: dict):
    try:
        parsed = SignalingModel(**msg_data)
    except ValidationError:
        await send_json(ws, {"t": "error", "code": "bad_frame"})
        return

    target = parsed.target
    if target:
        for target_ws, info in clients.items():
            if info.get("peer_id") == target:
                await send_json(target_ws, {
                    "t": parsed.t,
                    "sender": clients[ws]["peer_id"],
                    "sender_name": clients[ws]["name"],
                    "data": parsed.data
                })
                break
    elif parsed.t == "p2p_file":
        current_room = clients[ws]["room"]
        for target_ws, info in clients.items():
            if target_ws != ws and info.get("room") == current_room:
                await send_json(target_ws, {
                    "t": "p2p_file",
                    "sender": clients[ws]["peer_id"],
                    "sender_name": clients[ws]["name"],
                    "data": parsed.data
                })

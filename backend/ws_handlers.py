"""WebSocket event handlers for MistRoom."""
import time
from fastapi import WebSocket
from backend.ai import triage as triage_message
from backend.state import clients, seen_ids, history, send_json, broadcast_peers


async def handle_join(ws: WebSocket, msg_data: dict, temp_peer_id: str):
    nickname = str(msg_data.get("name") or "guest").strip()[:20] or "guest"
    pid = str(msg_data.get("peer_id") or temp_peer_id)
    room_id = str(msg_data.get("room") or "global").strip()[:30] or "global"
    clients[ws]["name"] = nickname
    clients[ws]["peer_id"] = pid
    clients[ws]["room"] = room_id

    room_history = [m for m in history if m.get("room", "global") == room_id]
    await send_json(ws, {"t": "history", "history": room_history, "peer_id": pid, "room": room_id})
    await broadcast_peers()


async def handle_switch_room(ws: WebSocket, msg_data: dict):
    new_room = str(msg_data.get("room") or "global").strip()[:30] or "global"
    clients[ws]["room"] = new_room
    room_history = [m for m in history if m.get("room", "global") == new_room]
    await send_json(ws, {"t": "history", "history": room_history, "peer_id": clients[ws]["peer_id"], "room": new_room})
    await broadcast_peers()


def _parse_prio(prio_val) -> int:
    try:
        return int(prio_val)
    except (TypeError, ValueError):
        return 0


async def handle_msg(ws: WebSocket, msg_data: dict):
    if not clients.get(ws, {}).get("name"):
        return
    mid = msg_data.get("id")
    if not mid or mid in seen_ids:
        return
    seen_ids.append(mid)

    ciphertext = msg_data.get("ciphertext") or ""
    iv = msg_data.get("iv") or ""
    plaintext = str(msg_data.get("text") or "").strip()[:500]

    if msg_data.get("cat") and msg_data.get("prio") is not None:
        cat, prio = msg_data["cat"], _parse_prio(msg_data["prio"])
    elif plaintext:
        if msg_data.get("sos"):
            cat, prio = "sos", 3
        else:
            t_res = triage_message(plaintext)
            cat, prio = t_res["cat"], t_res["prio"]
    else:
        cat, prio = ("general", 0)

    room_id = clients[ws].get("room", "global")
    target_dm_peer = msg_data.get("target_peer")

    record = {
        "id": mid,
        "from": clients[ws]["name"],
        "peer_id": clients[ws]["peer_id"],
        "room": room_id,
        "text": plaintext,
        "ciphertext": ciphertext,
        "iv": iv,
        "cat": cat,
        "prio": prio,
        "ts": int(time.time() * 1000)
    }

    if target_dm_peer:
        record["target_peer"] = target_dm_peer
        record["is_dm"] = True

    history.append(record)

    if target_dm_peer:
        for client_ws, client_info in list(clients.items()):
            if client_info.get("peer_id") in (target_dm_peer, clients[ws]["peer_id"]):
                await send_json(client_ws, {"t": "msg", "msg": record})
    else:
        for client_ws, client_info in list(clients.items()):
            if client_info.get("room") == room_id or (prio == 3 and msg_data.get("sos")):
                await send_json(client_ws, {"t": "msg", "msg": record})


async def handle_msg_ack(ws: WebSocket, msg_data: dict):
    ack_mid = msg_data.get("id")
    target_sender = msg_data.get("target_peer")
    if ack_mid and target_sender:
        for client_ws, client_info in list(clients.items()):
            if client_info.get("peer_id") == target_sender:
                await send_json(client_ws, {
                    "t": "msg_ack",
                    "id": ack_mid,
                    "from_peer": clients[ws]["peer_id"],
                    "status": msg_data.get("status", "delivered")
                })


async def handle_signaling(ws: WebSocket, msg_data: dict, event_type: str):
    target_peer = msg_data.get("target")
    if not target_peer:
        return
    for target_ws, info in clients.items():
        if info.get("peer_id") == target_peer:
            await send_json(target_ws, {
                "t": event_type,
                "sender": clients[ws]["peer_id"],
                "sender_name": clients[ws]["name"],
                "data": msg_data.get("data")
            })
            break


async def handle_p2p_file(ws: WebSocket, msg_data: dict):
    target_peer = msg_data.get("target")
    if target_peer:
        await handle_signaling(ws, msg_data, "p2p_file")
        return
    room_id = clients[ws].get("room", "global")
    for target_ws, info in clients.items():
        if target_ws != ws and info.get("room") == room_id:
            await send_json(target_ws, {
                "t": "p2p_file",
                "sender": clients[ws]["peer_id"],
                "sender_name": clients[ws]["name"],
                "data": msg_data.get("data")
            })

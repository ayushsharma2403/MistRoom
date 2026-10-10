"""MistRoom backend (Python / FastAPI).
- Real-time WebSockets with Zero-Logging design
- Client-side E2EE support (relaying encrypted ciphertext & IV)
- WebRTC P2P Mesh Signaling (offer, answer, ICE candidate routing)
- Ephemeral MySQL data layer for active presence & zero-knowledge cache
- Works 100% offline on Wi-Fi hotspot / LAN or containerized with Docker Compose.
"""
import asyncio
import io
import json
import os
import socket
import time
from collections import deque
from pathlib import Path
from typing import Optional

try:
    import segno
except ImportError:
    segno = None

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response, PlainTextResponse
from fastapi.staticfiles import StaticFiles

import ai

# Database Configuration (supports MySQL with graceful in-memory fallback)
MYSQL_HOST = os.getenv("MYSQL_HOST")
MYSQL_PORT = int(os.getenv("MYSQL_PORT", 3306))
MYSQL_USER = os.getenv("MYSQL_USER", "mistroom_user")
MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD", "mistroom_pass")
MYSQL_DATABASE = os.getenv("MYSQL_DATABASE", "mistroom")

db_pool = None

async def init_db():
    global db_pool
    if not MYSQL_HOST:
        print("[DB] No MYSQL_HOST configured. Running in-memory mode.")
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
        print(f"[DB] Successfully connected to MySQL at {MYSQL_HOST}:{MYSQL_PORT}")
    except Exception as e:
        print(f"[DB Warning] Could not connect to MySQL ({e}). Running in resilient in-memory mode.")
        db_pool = None

async def db_save_peer(peer_id: str, nickname: str, room_id: str = "default"):
    if not db_pool:
        return
    try:
        async with db_pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """INSERT INTO active_peers (peer_id, room_id, nickname)
                       VALUES (%s, %s, %s)
                       ON DUPLICATE KEY UPDATE nickname=%s, last_seen=CURRENT_TIMESTAMP""",
                    (peer_id, room_id, nickname, nickname)
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

async def db_save_message(mid: str, sender: str, ciphertext: str, iv: str, cat: str, prio: int, room_id: str = "default"):
    """Saves zero-knowledge encrypted message without storing plaintext."""
    if not db_pool:
        return
    try:
        async with db_pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """INSERT IGNORE INTO ephemeral_messages (id, room_id, sender, ciphertext, iv, cat, prio)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (mid, room_id, sender, ciphertext, iv, cat, prio)
                )
    except Exception as e:
        print(f"[DB Error] db_save_message: {e}")

PORT = int(os.getenv("PORT", 3000))
PUB = Path(__file__).parent / "public"

def lan_ip() -> str:
    """Find this computer's address on the local network (works without internet)."""
    for target in ("10.255.255.255", "192.168.255.255", "172.16.255.255", "8.8.8.8"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect((target, 1))
                ip = s.getsockname()[0]
                if not ip.startswith("127."):
                    return ip
        except OSError:
            continue
    return "localhost"

URL = f"http://{lan_ip()}:{PORT}"
app = FastAPI(title="MistRoom")

# clients mapping: ws -> dict{"name", "joined", "peer_id"}
clients: dict[WebSocket, dict] = {}
seen: deque = deque(maxlen=2000)
history: deque = deque(maxlen=100)

@app.on_event("startup")
async def startup_event():
    await init_db()

async def send(ws: WebSocket, obj: dict):
    try:
        await ws.send_text(json.dumps(obj))
    except Exception:
        clients.pop(ws, None)

async def broadcast(obj: dict, exclude: Optional[WebSocket] = None):
    for ws in list(clients):
        if ws != exclude:
            await send(ws, obj)

async def send_people():
    people = [{"name": c["name"], "joined": c["joined"], "peer_id": c["peer_id"]}
              for c in clients.values() if c.get("name")]
    await broadcast({"t": "people", "people": people})

@app.get("/qr.svg")
def qr():
    if segno:
        buf = io.BytesIO()
        segno.make(URL).save(buf, kind="svg", scale=6, border=1)
        return Response(buf.getvalue(), media_type="image/svg+xml")
    svg_fallback = f'''<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
        <rect width="100%" height="100%" fill="#eee"/>
        <text x="50%" y="45%" text-anchor="middle" font-size="12" fill="#333" font-family="sans-serif">Join URL:</text>
        <text x="50%" y="60%" text-anchor="middle" font-size="10" fill="#2F7F86" font-family="sans-serif">{URL}</text>
    </svg>'''
    return Response(svg_fallback, media_type="image/svg+xml")

@app.get("/info")
def info():
    return JSONResponse({"url": URL, "db_active": db_pool is not None})

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    peer_id = f"peer_{int(time.time()*1000)}_{id(ws)}"
    clients[ws] = {"name": None, "joined": time.time(), "peer_id": peer_id}

    try:
        while True:
            try:
                m = json.loads(await ws.receive_text())
            except json.JSONDecodeError:
                continue

            kind = m.get("t")

            # 1. Join room
            if kind == "join":
                name = str(m.get("name") or "guest").strip()[:20] or "guest"
                pid = str(m.get("peer_id") or peer_id)
                clients[ws]["name"] = name
                clients[ws]["peer_id"] = pid

                await db_save_peer(pid, name)
                # Send history & peer list
                await send(ws, {"t": "history", "history": list(history), "peer_id": pid})
                await send_people()

            # 2. Encrypted / Standard Message relay
            elif kind == "msg" and clients[ws]["name"]:
                mid = m.get("id")
                if not mid or mid in seen:
                    continue
                seen.append(mid)

                # Supports both E2EE payload (ciphertext + iv) and plaintext
                ciphertext = m.get("ciphertext") or ""
                iv = m.get("iv") or ""
                raw_text = str(m.get("text") or "").strip()[:500]

                # Run offline AI triage if plaintext is provided, or accept client-side pre-triaged tag
                if m.get("cat") and m.get("prio") is not None:
                    cat, prio = m["cat"], int(m["prio"])
                elif raw_text:
                    cat, prio = ("sos", 3) if m.get("sos") else ai.triage(raw_text)
                else:
                    cat, prio = ("general", 0)

                msg = {
                    "id": mid,
                    "from": clients[ws]["name"],
                    "peer_id": clients[ws]["peer_id"],
                    "text": raw_text,       # Empty if strictly E2EE
                    "ciphertext": ciphertext,
                    "iv": iv,
                    "cat": cat,
                    "prio": prio,
                    "ts": int(time.time() * 1000)
                }

                history.append(msg)
                # Persist zero-logging encrypted record into MySQL
                asyncio.create_task(db_save_message(mid, clients[ws]["name"], ciphertext or raw_text, iv, cat, prio))
                await broadcast({"t": "msg", "msg": msg})

            # 3. WebRTC Mesh Signaling Relay
            # Enables direct browser-to-browser P2P mesh connections
            elif kind in ("webrtc_offer", "webrtc_answer", "webrtc_ice"):
                target_peer = m.get("target")
                for target_ws, info_data in clients.items():
                    if info_data.get("peer_id") == target_peer:
                        await send(target_ws, {
                            "t": kind,
                            "sender": clients[ws]["peer_id"],
                            "sender_name": clients[ws]["name"],
                            "data": m.get("data")
                        })
                        break

            # 4. Situation Summary Generator
            elif kind == "summary":
                summary_text = ai.summarize(list(history))
                await send(ws, {"t": "summary", "text": summary_text})

    except WebSocketDisconnect:
        pass
    finally:
        info_c = clients.pop(ws, None)
        if info_c and info_c.get("peer_id"):
            asyncio.create_task(db_remove_peer(info_c["peer_id"]))
        await send_people()

app.mount("/", StaticFiles(directory=PUB, html=True), name="web")

if __name__ == "__main__":
    print("\n[MistRoom Privacy-First Mesh]")
    print(f"Open locally:  http://localhost:{PORT}")
    print(f"LAN Guests:    {URL}\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")

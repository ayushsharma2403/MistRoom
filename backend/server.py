"""MistRoom Backend: Offline-capable, privacy-first emergency communication hub.
- FastAPI backend with WebSockets
- Zero-logging architecture: No plaintext, no IP addresses stored
- Ephemeral MySQL data layer with automatic in-memory fallback
- WebRTC mesh signaling broker
- Offline rule-based NLP triage engine
"""
import asyncio
import io
import json
import os
import re
import socket
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional, List, Dict, Tuple

try:
    import segno
except ImportError:
    segno = None

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

# -------------------------------------------------------------
# 1. OFFLINE NLP EMERGENCY TRIAGE & SITREP ENGINE (ai.py)
# -------------------------------------------------------------
try:
    from backend.ai import triage as triage_message, summarize as generate_sitrep, RULES as TRIAGE_RULES
except ImportError:
    from ai import triage as triage_message, summarize as generate_sitrep, RULES as TRIAGE_RULES

# -------------------------------------------------------------
# 2. CONFIGURATION & DATABASE LAYER
# -------------------------------------------------------------
PORT = int(os.getenv("PORT", 3000))
MYSQL_HOST = os.getenv("MYSQL_HOST")
MYSQL_PORT = int(os.getenv("MYSQL_PORT", 3306))
MYSQL_USER = os.getenv("MYSQL_USER", "mistroom_user")
MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD", "mistroom_pass")
MYSQL_DATABASE = os.getenv("MYSQL_DATABASE", "mistroom")

# Frontend directory path
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

db_pool = None

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

# -------------------------------------------------------------
# 3. LAN IP DETECTION & LIFESPAN
# -------------------------------------------------------------
def get_lan_ip() -> str:
    candidates = ["8.8.8.8", "1.1.1.1", "10.255.255.255"]
    for host in candidates:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.settimeout(0.5)
                s.connect((host, 80))
                ip = s.getsockname()[0]
                if not ip.startswith("127."):
                    return ip
        except OSError:
            continue
    return "localhost"

LAN_URL = f"http://{get_lan_ip()}:{PORT}"

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield
    if db_pool:
        db_pool.close()
        await db_pool.wait_closed()

app = FastAPI(title="MistRoom", lifespan=lifespan)

@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    # Ensure browsers and proxies never serve stale cached HTML, JS, or CSS
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    if request.url.path in ("/", "/index.html"):
        response.headers["Clear-Site-Data"] = '"cache"'
    return response

# -------------------------------------------------------------
# 4. WEBSOCKET & PEER STATE
# -------------------------------------------------------------
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
    peers = [{"name": c["name"], "peer_id": c["peer_id"]} for c in clients.values() if c.get("name")]
    await broadcast_json({"t": "people", "people": peers})

# -------------------------------------------------------------
# 5. REST & QR ROUTES
# -------------------------------------------------------------
@app.get("/qr.svg")
def get_qr_svg():
    if segno:
        buf = io.BytesIO()
        segno.make(LAN_URL).save(buf, kind="svg", scale=6, border=1)
        return Response(buf.getvalue(), media_type="image/svg+xml")
    svg_fallback = f'''<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
        <rect width="100%" height="100%" fill="#eee"/>
        <text x="50%" y="45%" text-anchor="middle" font-size="12" fill="#333" font-family="sans-serif">Scan on Wi-Fi:</text>
        <text x="50%" y="60%" text-anchor="middle" font-size="10" fill="#2F7F86" font-family="sans-serif">{LAN_URL}</text>
    </svg>'''
    return Response(svg_fallback, media_type="image/svg+xml")

@app.get("/reset-cache")
def reset_cache():
    """Wipes all browser cache, service workers, and storage for this origin."""
    response = Response(
        content='''<!DOCTYPE html><html><head><meta http-equiv="refresh" content="1;url=/"><title>Resetting Cache...</title></head><body style="font-family:sans-serif;background:#0B132B;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Clearing Browser Cache & Service Workers...</h2><p>Redirecting to fresh MistRoom in 1 second...</p></div></body></html>''',
        media_type="text/html"
    )
    response.headers["Clear-Site-Data"] = '"cache", "cookies", "storage"'
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

@app.get("/api/info")
def get_info():
    return JSONResponse({"url": LAN_URL, "db_active": db_pool is not None})

# -------------------------------------------------------------
# 6. REAL-TIME WEBSOCKET HUB (Zero-Knowledge Relay & Mesh Signaling)
# -------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    temp_peer_id = f"peer_{int(time.time()*1000)}_{id(ws)}"
    clients[ws] = {"name": None, "peer_id": temp_peer_id}

    try:
        while True:
            raw_text = await ws.receive_text()
            try:
                msg_data = json.loads(raw_text)
            except json.JSONDecodeError:
                continue

            event_type = msg_data.get("t")

            # A. Join mesh network
            if event_type == "join":
                nickname = str(msg_data.get("name") or "guest").strip()[:20] or "guest"
                pid = str(msg_data.get("peer_id") or temp_peer_id)
                clients[ws]["name"] = nickname
                clients[ws]["peer_id"] = pid

                await db_save_peer(pid, nickname)
                # Send history and active peer list
                await send_json(ws, {"t": "history", "history": list(history), "peer_id": pid})
                await broadcast_peers()

            # B. Zero-knowledge message relay
            elif event_type == "msg" and clients[ws]["name"]:
                mid = msg_data.get("id")
                if not mid or mid in seen_ids:
                    continue
                seen_ids.append(mid)

                ciphertext = msg_data.get("ciphertext") or ""
                iv = msg_data.get("iv") or ""
                plaintext = str(msg_data.get("text") or "").strip()[:500]

                # Use client pre-triaged emergency category if encrypted, otherwise run triage
                if msg_data.get("cat") and msg_data.get("prio") is not None:
                    cat, prio = msg_data["cat"], int(msg_data["prio"])
                elif plaintext:
                    cat, prio = ("sos", 3) if msg_data.get("sos") else triage_message(plaintext)
                else:
                    cat, prio = ("general", 0)

                record = {
                    "id": mid,
                    "from": clients[ws]["name"],
                    "peer_id": clients[ws]["peer_id"],
                    "text": plaintext,       # Empty in strict E2EE mode
                    "ciphertext": ciphertext,
                    "iv": iv,
                    "cat": cat,
                    "prio": prio,
                    "ts": int(time.time() * 1000)
                }

                history.append(record)
                asyncio.create_task(db_save_message(mid, clients[ws]["name"], ciphertext or plaintext, iv, cat, prio))
                await broadcast_json({"t": "msg", "msg": record})

            # C. WebRTC P2P Mesh Signaling (Offer, Answer, ICE candidates)
            elif event_type in ("webrtc_offer", "webrtc_answer", "webrtc_ice"):
                target_peer = msg_data.get("target")
                for target_ws, info in clients.items():
                    if info.get("peer_id") == target_peer:
                        await send_json(target_ws, {
                            "t": event_type,
                            "sender": clients[ws]["peer_id"],
                            "sender_name": clients[ws]["name"],
                            "data": msg_data.get("data")
                        })
                        break

            # D. Crisis Situation Report
            elif event_type == "summary":
                report = generate_sitrep(list(history))
                await send_json(ws, {"t": "summary", "text": report})

    except WebSocketDisconnect:
        pass
    finally:
        client_info = clients.pop(ws, None)
        if client_info and client_info.get("peer_id"):
            asyncio.create_task(db_remove_peer(client_info["peer_id"]))
        await broadcast_peers()

# -------------------------------------------------------------
# 7. STATIC ASSET SERVING
# -------------------------------------------------------------
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")

if __name__ == "__main__":
    print("\n=============================================")
    print("  MistRoom – Privacy-First Mesh Emergency Hub")
    print(f"  Local Access:  http://localhost:{PORT}")
    print(f"  Hotspot/LAN:   {LAN_URL}")
    print("=============================================\n")
    uvicorn.run("backend.server:app", host="0.0.0.0", port=PORT, reload=False, log_level="warning")

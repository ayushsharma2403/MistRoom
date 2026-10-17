"""MistRoom Backend: App creation, rate-limiting, origin validation, and security headers."""
import base64
import hashlib
import json
import os
import time
from collections import deque
from pathlib import Path
from urllib.parse import urlparse

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import PORT, FRONTEND_DIR, BASE_DIR
from backend.state import clients, broadcast_peers, ip_connections
from backend.routes import router as rest_router, LAN_URL
from backend.ws_handlers import (
    handle_join_v2, handle_switch_room_v2, handle_msg_v2,
    handle_msg_ack_v2, handle_signaling_v2, handle_beacon_v2,
    handle_need_resolved_v2
)

app = FastAPI(title="MistRoom")
app.add_middleware(GZipMiddleware, minimum_size=1000)

_INDEX_PATH = FRONTEND_DIR / "index.html"
_INDEX_ETAG = ""
if _INDEX_PATH.exists():
    _INDEX_ETAG = f'"{hashlib.md5(_INDEX_PATH.read_bytes()).hexdigest()[:16]}"'


@app.middleware("http")
async def add_security_headers(request, call_next):
    path = request.url.path
    if_none_match = request.headers.get("if-none-match")

    response = await call_next(request)

    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self'; "
        "img-src 'self' blob: data:; "
        "connect-src 'self' ws: wss:; "
        "media-src 'self' blob:; "
        "object-src 'none'; "
        "base-uri 'none'"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"

    if path in ("/", "/index.html"):
        response.headers["Cache-Control"] = "no-cache"
        if _INDEX_ETAG:
            response.headers["ETag"] = _INDEX_ETAG
            if if_none_match == _INDEX_ETAG:
                response.status_code = 304
    elif path.startswith("/assets/") or (len(Path(path).stem.split(".")) > 1):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


app.include_router(rest_router)


class TokenBucket:
    """Per-connection token bucket rate limiter: max 20 msgs/sec, max 200 msgs/min."""
    def __init__(self):
        self.sec_timestamps = deque(maxlen=20)
        self.min_timestamps = deque(maxlen=200)

    def allow(self) -> bool:
        now = time.monotonic()
        if len(self.sec_timestamps) == 20 and now - self.sec_timestamps[0] < 1.0:
            return False
        if len(self.min_timestamps) == 200 and now - self.min_timestamps[0] < 60.0:
            return False
        self.sec_timestamps.append(now)
        self.min_timestamps.append(now)
        return True


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    # Origin verification: Origin host must equal Host header
    origin = ws.headers.get("origin")
    host = ws.headers.get("host")
    if origin and host:
        parsed_origin = urlparse(origin)
        origin_host = parsed_origin.netloc.lower()
        if origin_host != host.lower():
            # Prompt 8: only accept WebSocket upgrades whose Origin host equals Host header (reject otherwise with 403)
            await ws.close(code=1008, reason="Forbidden Origin")
            return

    # Ephemeral IP connection counter (in-memory only, no IPs logged)
    client_ip = ws.client.host if ws.client else "unknown"
    if ip_connections[client_ip] >= 200:
        await ws.close(code=1008, reason="Connection limit exceeded")
        return
    ip_connections[client_ip] += 1

    await ws.accept()

    # Challenge-response handshake
    challenge_nonce = base64.b64encode(os.urandom(16)).decode("ascii")
    await ws.send_text(json.dumps({"t": "challenge", "nonce": challenge_nonce}))

    clients[ws] = {"name": None, "peer_id": None, "room": None, "pk": None}
    rate_limiter = TokenBucket()

    try:
        while True:
            # 64 KB maximum frame size limit
            raw_text = await ws.receive_text()
            if len(raw_text.encode("utf-8")) > 64 * 1024:
                await ws.close(code=1009, reason="Message too large")
                break

            # Rate limit check
            if not rate_limiter.allow():
                await ws.send_text(json.dumps({
                    "t": "error", "code": "rate_limited", "text": "Too many messages"
                }))
                continue

            try:
                msg_data = json.loads(raw_text)
            except Exception:
                await ws.send_text(json.dumps({"t": "error", "code": "bad_frame"}))
                continue

            if not isinstance(msg_data, dict):
                await ws.send_text(json.dumps({"t": "error", "code": "bad_frame"}))
                continue

            event_type = msg_data.get("t")

            if event_type == "join":
                await handle_join_v2(ws, msg_data, challenge_nonce)
            elif event_type == "switch_room":
                await handle_switch_room_v2(ws, msg_data)
            elif event_type == "msg":
                await handle_msg_v2(ws, msg_data)
            elif event_type == "beacon":
                await handle_beacon_v2(ws, msg_data)
            elif event_type == "need_resolved":
                await handle_need_resolved_v2(ws, msg_data)
            elif event_type == "msg_ack":
                await handle_msg_ack_v2(ws, msg_data)
            elif event_type in ("webrtc_offer", "webrtc_answer", "webrtc_ice",
                                "call_invite", "call_accept", "call_decline",
                                "call_hangup", "call_ice", "p2p_file"):
                await handle_signaling_v2(ws, msg_data)
            else:
                await ws.send_text(json.dumps({"t": "error", "code": "bad_frame"}))

    except WebSocketDisconnect:
        pass
    finally:
        ip_connections[client_ip] -= 1
        if ip_connections[client_ip] <= 0:
            ip_connections.pop(client_ip, None)
        clients.pop(ws, None)
        await broadcast_peers()


SHARED_DIR = BASE_DIR / "shared"
if SHARED_DIR.exists():
    app.mount("/shared", StaticFiles(directory=str(SHARED_DIR)), name="shared")

if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")

if __name__ == "__main__":
    print("\n=============================================")
    print("  MistRoom – Privacy-First Mesh Emergency Hub")
    print(f"  Local Access:  http://localhost:{PORT}")
    print(f"  Hotspot/LAN:   {LAN_URL}")
    print("=============================================\n")
    uvicorn.run("backend.server:app", host="0.0.0.0", port=PORT, reload=False, log_level="warning")

"""MistRoom Backend: App creation and static mounting."""
import hashlib
import json
import time
from pathlib import Path
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import PORT, FRONTEND_DIR
from backend.state import clients, broadcast_peers
from backend.routes import router as rest_router, LAN_URL
from backend.ws_handlers import (
    handle_join, handle_switch_room, handle_msg, handle_msg_ack,
    handle_signaling, handle_p2p_file
)

app = FastAPI(title="MistRoom")
app.add_middleware(GZipMiddleware, minimum_size=1000)

_INDEX_PATH = FRONTEND_DIR / "index.html"
_INDEX_ETAG = ""
if _INDEX_PATH.exists():
    _INDEX_ETAG = f'"{hashlib.md5(_INDEX_PATH.read_bytes()).hexdigest()[:16]}"'


@app.middleware("http")
async def add_cache_headers(request, call_next):
    path = request.url.path
    if_none_match = request.headers.get("if-none-match")

    response = await call_next(request)

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
            except Exception:
                continue

            if not isinstance(msg_data, dict):
                continue

            event_type = msg_data.get("t")

            if event_type == "join":
                await handle_join(ws, msg_data, temp_peer_id)
            elif event_type == "switch_room":
                await handle_switch_room(ws, msg_data)
            elif event_type == "msg":
                await handle_msg(ws, msg_data)
            elif event_type == "msg_ack":
                await handle_msg_ack(ws, msg_data)
            elif event_type in ("webrtc_offer", "webrtc_answer", "webrtc_ice",
                                "call_invite", "call_accept", "call_decline",
                                "call_hangup", "call_ice"):
                await handle_signaling(ws, msg_data, event_type)
            elif event_type == "p2p_file":
                await handle_p2p_file(ws, msg_data)

    except WebSocketDisconnect:
        pass
    finally:
        clients.pop(ws, None)
        await broadcast_peers()


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="static")

if __name__ == "__main__":
    print("\n=============================================")
    print("  MistRoom – Privacy-First Mesh Emergency Hub")
    print(f"  Local Access:  http://localhost:{PORT}")
    print(f"  Hotspot/LAN:   {LAN_URL}")
    print("=============================================\n")
    uvicorn.run("backend.server:app", host="0.0.0.0", port=PORT, reload=False, log_level="warning")

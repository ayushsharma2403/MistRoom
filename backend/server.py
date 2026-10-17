"""MistRoom Backend: App creation, lifespan, and static mounting."""
import json
import time
import asyncio
from contextlib import asynccontextmanager
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from backend.config import PORT, FRONTEND_DIR
from backend.state import init_db, close_db, clients, db_remove_peer, broadcast_peers
from backend.routes import router as rest_router, LAN_URL
from backend.ws_handlers import (
    handle_join, handle_switch_room, handle_msg, handle_msg_ack,
    handle_signaling, handle_p2p_file
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield
    await close_db()


app = FastAPI(title="MistRoom", lifespan=lifespan)


@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    if request.url.path in ("/", "/index.html"):
        response.headers["Clear-Site-Data"] = '"cache"'
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
        client_info = clients.pop(ws, None)
        if client_info and client_info.get("peer_id"):
            asyncio.create_task(db_remove_peer(client_info["peer_id"]))
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

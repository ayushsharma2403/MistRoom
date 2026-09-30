"""MistRoom backend (Python / FastAPI).
Serves the web app and relays chat over WebSocket on a local Wi-Fi / hotspot.
No internet needed. Run:  python server.py
"""
import io
import json
import socket
import time
from collections import deque
from pathlib import Path

import segno
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import ai

PORT = 3000
PUB = Path(__file__).parent / "public"


def lan_ip() -> str:
    """Find this computer's address on the local network (works without internet)."""
    for target in ("10.255.255.255", "192.168.255.255", "172.16.255.255", "8.8.8.8"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect((target, 1))  # UDP connect sends nothing
                ip = s.getsockname()[0]
                if not ip.startswith("127."):
                    return ip
        except OSError:
            continue
    return "localhost"


URL = f"http://{lan_ip()}:{PORT}"
app = FastAPI(title="MistRoom")

clients: dict[WebSocket, dict] = {}          # socket -> {"name", "joined"}
seen: deque = deque(maxlen=2000)             # message ids already relayed
history: deque = deque(maxlen=100)           # recent messages for late joiners


async def send(ws: WebSocket, obj: dict):
    try:
        await ws.send_text(json.dumps(obj))
    except Exception:
        clients.pop(ws, None)


async def broadcast(obj: dict):
    for ws in list(clients):
        await send(ws, obj)


async def send_people():
    people = [{"name": c["name"], "joined": c["joined"]} for c in clients.values()]
    await broadcast({"t": "people", "people": people})


@app.get("/qr.svg")
def qr():
    buf = io.BytesIO()
    segno.make(URL).save(buf, kind="svg", scale=6, border=1)
    return Response(buf.getvalue(), media_type="image/svg+xml")


@app.get("/info")
def info():
    return JSONResponse({"url": URL})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients[ws] = {"name": None, "joined": time.time()}
    try:
        while True:
            try:
                m = json.loads(await ws.receive_text())
            except json.JSONDecodeError:
                continue
            kind = m.get("t")
            if kind == "join":
                name = str(m.get("name") or "guest").strip()[:20] or "guest"
                clients[ws] = {"name": name, "joined": time.time()}
                await send(ws, {"t": "history", "history": list(history)})
                await send_people()
            elif kind == "msg" and clients[ws]["name"]:
                mid = m.get("id")
                if not mid or mid in seen:          # drop duplicates
                    continue
                seen.append(mid)
                text = str(m.get("text") or "").strip()[:500]
                if not text:
                    continue
                cat, prio = ("sos", 3) if m.get("sos") else ai.triage(text)   # AI triage
                msg = {"id": mid, "from": clients[ws]["name"], "text": text,
                       "cat": cat, "prio": prio, "ts": int(time.time() * 1000)}
                history.append(msg)
                await broadcast({"t": "msg", "msg": msg})
            elif kind == "summary":
                await send(ws, {"t": "summary", "text": ai.summarize(list(history))})
    except WebSocketDisconnect:
        pass
    finally:
        clients.pop(ws, None)
        await send_people()


app.mount("/", StaticFiles(directory=PUB, html=True), name="web")

if __name__ == "__main__":
    print("\nMistRoom is running.")
    print(f"Open on this computer:  http://localhost:{PORT}")
    print(f"Guests join at:         {URL}\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")

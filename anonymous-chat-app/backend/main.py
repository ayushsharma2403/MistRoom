import random
import string
import uuid
import json
from datetime import datetime
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from models import GroupCreate, GroupResponse, MessageResponse
from database import init_db, save_group, get_group, get_all_groups, save_message, get_group_messages

# Preset Anonymous Avatars, Aliases and Themes
ALIASES_ADJECTIVES = ["Cyber", "Neon", "Shadow", "Quantum", "Digital", "Vapor", "Aura", "Binary", "Crypto", "Phantom", "Silent", "Cosmic"]
ALIASES_NOUNS = ["Falcon", "Nomad", "Fox", "Spectre", "Rogue", "Ghost", "Sentinel", "Cipher", "Viper", "Oracle", "Spark", "Monk"]
AVATARS = ["⚡", "🔮", "🎭", "👾", "🐉", "🦊", "🛸", "🛡️", "🌌", "💎", "🐺", "🦅"]
COLORS = ["#8b5cf6", "#ec4899", "#3b82f6", "#10b981", "#f59e0b", "#06b6d4", "#a855f7", "#ef4444"]

def generate_group_id(length: int = 6) -> str:
    chars = string.ascii_lowercase + string.digits
    return ''.join(random.choice(chars) for _ in range(length))

def generate_anonymous_identity(peer_id: str) -> dict:
    rand = random.Random(peer_id)
    adj = rand.choice(ALIASES_ADJECTIVES)
    noun = rand.choice(ALIASES_NOUNS)
    avatar = rand.choice(AVATARS)
    color = rand.choice(COLORS)
    return {
        "peerId": peer_id,
        "alias": f"{adj} {noun}",
        "avatar": avatar,
        "color": color
    }

# WebRTC P2P Signaling Server Connection Manager
class SignalingManager:
    def __init__(self):
        # group_id -> dict of peer_id -> { "ws": WebSocket, "info": dict }
        self.rooms: Dict[str, Dict[str, dict]] = {}

    async def connect(self, group_id: str, peer_id: str, websocket: WebSocket, peer_info: dict):
        await websocket.accept()
        if group_id not in self.rooms:
            self.rooms[group_id] = {}
        self.rooms[group_id][peer_id] = {
            "ws": websocket,
            "info": peer_info
        }

    def disconnect(self, group_id: str, peer_id: str):
        if group_id in self.rooms and peer_id in self.rooms[group_id]:
            del self.rooms[group_id][peer_id]
            if not self.rooms[group_id]:
                del self.rooms[group_id]

    def get_room_peers(self, group_id: str) -> List[dict]:
        if group_id not in self.rooms:
            return []
        return [data["info"] for data in self.rooms[group_id].values()]

    async def send_to_peer(self, group_id: str, target_peer_id: str, message: dict):
        if group_id in self.rooms and target_peer_id in self.rooms[group_id]:
            try:
                await self.rooms[group_id][target_peer_id]["ws"].send_json(message)
            except Exception as e:
                print(f"[Signaling Error] Failed send to {target_peer_id}: {e}")
                self.disconnect(group_id, target_peer_id)

    async def broadcast_except(self, group_id: str, sender_peer_id: str, message: dict):
        if group_id in self.rooms:
            disconnected = []
            for p_id, data in self.rooms[group_id].items():
                if p_id != sender_peer_id:
                    try:
                        await data["ws"].send_json(message)
                    except Exception:
                        disconnected.append(p_id)
            for p_id in disconnected:
                self.disconnect(group_id, p_id)

signaling = SignalingManager()

@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield

app = FastAPI(
    title="CloakRoom P2P WebRTC Signaling API",
    description="Python FastAPI backend serving as WebRTC Peer Discovery & Signaling Server for Mesh Topology",
    version="3.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# REST API Endpoints

@app.get("/")
async def root():
    return {
        "status": "online",
        "service": "CloakRoom P2P WebRTC Signaling Backend",
        "topology": "Peer-to-Peer (P2P) Mesh Network"
    }

@app.post("/api/groups", response_model=GroupResponse)
async def create_group(payload: GroupCreate):
    name = payload.name.strip() if payload.name and payload.name.strip() else "P2P Mesh Sanctum"
    
    for _ in range(5):
        gid = generate_group_id()
        existing = await get_group(gid)
        if not existing:
            break
    
    now_str = datetime.utcnow().isoformat() + "Z"
    group_data = {
        "groupId": gid,
        "name": name,
        "createdAt": now_str
    }
    
    await save_group(group_data)
    return group_data

@app.get("/api/groups", response_model=List[GroupResponse])
async def list_groups():
    return await get_all_groups()

@app.get("/api/groups/{group_id}", response_model=GroupResponse)
async def fetch_group(group_id: str):
    group = await get_group(group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Room not found")
    return group

@app.get("/api/groups/{group_id}/messages", response_model=List[MessageResponse])
async def fetch_messages(group_id: str):
    messages = await get_group_messages(group_id)
    formatted = []
    for m in messages:
        formatted.append({
            "id": m.get("id") or m.get("_id", str(uuid.uuid4())),
            "groupId": m.get("groupId", group_id),
            "text": m.get("text", ""),
            "senderId": m.get("senderId", "system"),
            "senderName": m.get("senderName", "Anonymous"),
            "avatar": m.get("avatar", "👻"),
            "color": m.get("color", "#a855f7"),
            "timestamp": m.get("timestamp", datetime.utcnow().isoformat() + "Z")
        })
    return formatted

# WebRTC P2P Signaling WebSocket Endpoint

@app.websocket("/ws/{group_id}")
async def websocket_endpoint(websocket: WebSocket, group_id: str):
    current_peer_id = None
    current_peer_info = None

    try:
        await websocket.accept()

        while True:
            raw_data = await websocket.receive_text()
            try:
                event = json.loads(raw_data)
            except json.JSONDecodeError:
                continue

            event_type = event.get("type")

            # 1. Join Signaling Event
            if event_type == "join":
                peer_id = event.get("peerId") or str(uuid.uuid4())[:8]
                current_peer_id = peer_id

                existing_group = await get_group(group_id)
                if not existing_group:
                    await save_group({
                        "groupId": group_id,
                        "name": f"P2P Room {group_id}",
                        "createdAt": datetime.utcnow().isoformat() + "Z"
                    })

                # Existing peers currently in room
                existing_peers = signaling.get_room_peers(group_id)

                identity = generate_anonymous_identity(peer_id)
                current_peer_info = {
                    "peerId": peer_id,
                    "alias": identity["alias"],
                    "avatar": identity["avatar"],
                    "color": identity["color"],
                    "joinedAt": datetime.utcnow().isoformat() + "Z"
                }

                # Register in connection manager
                if group_id not in signaling.rooms:
                    signaling.rooms[group_id] = {}
                signaling.rooms[group_id][peer_id] = {
                    "ws": websocket,
                    "info": current_peer_info
                }

                # Send ACK to newly joined peer with existing mesh peers list
                await websocket.send_json({
                    "type": "joined_ack",
                    "identity": current_peer_info,
                    "existingPeers": existing_peers,
                    "groupId": group_id
                })

                # Notify existing mesh peers that a new peer joined so they initiate P2P WebRTC offers
                await signaling.broadcast_except(group_id, peer_id, {
                    "type": "peer_joined",
                    "newPeer": current_peer_info
                })

            # 2. WebRTC Signaling Relays (Offer, Answer, ICE Candidates)
            elif event_type == "signal_offer":
                target_peer_id = event.get("targetPeerId")
                offer = event.get("offer")
                if target_peer_id and offer:
                    await signaling.send_to_peer(group_id, target_peer_id, {
                        "type": "signal_offer",
                        "fromPeerId": current_peer_id,
                        "fromPeerInfo": current_peer_info,
                        "offer": offer
                    })

            elif event_type == "signal_answer":
                target_peer_id = event.get("targetPeerId")
                answer = event.get("answer")
                if target_peer_id and answer:
                    await signaling.send_to_peer(group_id, target_peer_id, {
                        "type": "signal_answer",
                        "fromPeerId": current_peer_id,
                        "answer": answer
                    })

            elif event_type == "signal_ice":
                target_peer_id = event.get("targetPeerId")
                candidate = event.get("candidate")
                if target_peer_id and candidate:
                    await signaling.send_to_peer(group_id, target_peer_id, {
                        "type": "signal_ice",
                        "fromPeerId": current_peer_id,
                        "candidate": candidate
                    })

            # 3. Optional Server Message Backup Storage
            elif event_type == "store_message":
                msg_data = event.get("message")
                if msg_data:
                    await save_message(msg_data)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[Signaling WebSocket Error] {e}")
    finally:
        if group_id and current_peer_id:
            signaling.disconnect(group_id, current_peer_id)
            # Broadcast peer leave to remaining mesh peers
            await signaling.broadcast_except(group_id, current_peer_id, {
                "type": "peer_left",
                "peerId": current_peer_id,
                "peerInfo": current_peer_info
            })

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

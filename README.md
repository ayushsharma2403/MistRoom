# MistRoom – Privacy-First Anonymous Emergency Mesh Chat

> **Tech Stack:** Python (FastAPI), WebSockets, WebCrypto E2EE (AES-256-GCM), MySQL 8.0, WebRTC P2P DataChannels, Docker Compose

MistRoom is an offline-capable, privacy-first emergency communication application designed for disaster relief, crisis zones, and local network mesh messaging. It requires zero cloud access, no user accounts, and enforces a strict zero-logging design.

---

## 📁 Clean Directory Architecture

```
d:\1PROJECTS\MistRoom/
├── backend/
│   └── server.py         # FastAPI WebSocket relay, WebRTC signaling, MySQL layer & offline triage
├── frontend/
│   ├── index.html        # Clean, accessible UI with passkey setup, radar & emergency badges
│   ├── style.css         # Modern dark & light responsive CSS design system
│   └── app.js            # WebCrypto AES-256 E2EE, WebRTC RTCDataChannel mesh & client triage
├── docker-compose.yml    # Multi-container orchestration (FastAPI + MySQL 8.0)
├── Dockerfile            # Container build for backend & static frontend
├── init.sql              # MySQL zero-logging ephemeral tables
├── requirements.txt      # Python dependencies
└── README.md
```

---

## 🌟 Key Architecture & Features

1. **Client-Side E2EE (AES-256-GCM + PBKDF2)**:
   All messages are encrypted directly in the browser via the native Web Crypto API (`window.crypto.subtle`) using 100,000 PBKDF2 iterations. Central servers and network sniffers only see opaque Base64 ciphertext and IV.

2. **Zero-Logging Ephemeral MySQL Data Layer**:
   Stores active peer sessions and zero-knowledge ciphertext caches. Zero user identities, zero IP addresses, and zero plaintext are ever recorded. If MySQL is offline, the backend runs in resilient in-memory mode automatically.

3. **Offline Peer-to-Peer Mesh (WebRTC `RTCDataChannel`)**:
   Peers automatically establish browser-to-browser P2P data channels (`mistmesh`). If the central server drops, connected peers continue chatting uninterrupted.

4. **Intelligent Multilingual AI Triage & SitRep Engine**:
   Integrated dual-mode triage pipeline with Google Gemini AI and offline rule-based fallbacks for English, Hindi, and Hinglish. Automatically parses SOS, Medical, Logistics, and Safety priorities, computing real-time severity scoring (0–3) and emergency situational reports.

---

## 🚀 How to Run

### Option 1: Standalone Python
```bash
pip install -r requirements.txt
python -m backend.server
```
Open [http://localhost:3000](http://localhost:3000) on your laptop. Other devices on the same Wi-Fi or mobile hotspot can connect via your LAN IP or by scanning the displayed QR code.

### Option 2: Docker Compose (Full Stack with MySQL)
```bash
docker compose up --build
```
Open [http://localhost:3000](http://localhost:3000).

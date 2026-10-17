# MistRoom – Privacy-First Anonymous Emergency Mesh Chat

> **Tech Stack:** Python 3.11 (FastAPI, uvicorn), WebSockets, WebCrypto E2EE (AES-256-GCM), WebRTC P2P Voice & DataChannels, Docker

MistRoom is an offline-capable, privacy-first emergency communication application designed for disaster relief, crisis zones, women's safety, and local network mesh messaging. It operates completely memory-only by design: zero database, zero cloud access, no user accounts, and zero persistent storage of messages or user IP addresses.

---

## 📁 Clean Directory Architecture

```
d:\1PROJECTS\MistRoom/
├── backend/
│   ├── config.py         # Port and directory path configuration
│   ├── state.py          # In-memory clients, history, and message deduplication
│   ├── ws_handlers.py    # WebSocket event handlers (join, switch_room, msg, msg_ack, signaling, p2p_file)
│   ├── routes.py         # REST routes (/qr.svg, /api/info) and LAN IP detection
│   ├── ai.py             # Pure Python offline NLP triage engine and vital extraction
│   └── server.py         # FastAPI application, GZip middleware, static asset mounting
├── frontend/
│   ├── index.html        # Clean, accessible UI with passkey setup & emergency controls
│   ├── style.css         # Responsive CSS with automatic system light/dark theme
│   ├── app.js            # ES module coordinator and event wiring
│   └── js/
│       ├── state.js      # Centralized frontend state and DOM helpers
│       ├── crypto.js     # WebCrypto AES-256-GCM + PBKDF2 encryption/decryption
│       ├── triage.js     # Client-side emergency & safety triage
│       ├── outbox.js     # IndexedDB offline store-and-forward outbox
│       ├── settings.js   # Mnemonic seed recovery & ghost mode settings
│       ├── ui.js         # DOM message rendering and peer lists
│       ├── mesh.js       # WebRTC RTCDataChannel mesh networking
│       ├── files.js      # Encrypted P2P chunked file transfer
│       ├── calls.js      # 1-on-1 WebRTC P2P voice calling
│       └── ws.js         # WebSocket client relay and signaling
├── tests/
│   ├── test_triage.py    # Pytest NLP triage regression suite
│   ├── test_ws.py        # Pytest WebSocket integration tests
│   └── e2e/
│       └── test_playwright_e2e.py # Playwright automated E2E browser tests
├── tools/
│   ├── bench.py          # WebSocket connection & latency benchmark
│   └── build_assets.py   # Asset cache-busting versioning script
├── docker-compose.yml    # Single web service orchestration
├── Dockerfile            # Container build for FastAPI backend
├── requirements.txt      # Python dependencies
└── README.md
```

---

## 🌟 Key Architecture & Features

1. **Client-Side E2EE (AES-256-GCM + PBKDF2)**:
   All messages are encrypted directly in the browser via the native Web Crypto API (`window.crypto.subtle`) using 100,000 PBKDF2 iterations. Central servers and network sniffers only see opaque Base64 ciphertext and IV.

2. **Strictly In-Memory Zero-Logging Backend**:
   The FastAPI server keeps state in memory only. Zero databases, zero user identities, zero IP addresses, and zero plaintext are ever stored on disk. When the process exits, all ephemeral relay state disappears.

3. **Offline Peer-to-Peer Mesh (WebRTC `RTCDataChannel`)**:
   Peers automatically establish browser-to-browser P2P data channels (`mistmesh`) and voice calls. If the central server drops, connected peers continue communicating uninterrupted.

4. **Offline Rule-Based NLP Triage Engine**:
   Pure Python offline triage engine supporting English, Hindi, and Hinglish disaster and emergency vocabulary. Automatically classifies SOS, Medical, Logistics, Shelter, and Women's Safety priorities with real-time severity scoring (0–3) and vital signal extraction.

---

## 🚀 How to Run

### Option 1: Standalone Python
```bash
pip install -r requirements.txt
python -m backend.server
```
Open [http://localhost:3001](http://localhost:3001) in your browser. Other devices on the same Wi-Fi or mobile hotspot can connect via your LAN IP or by scanning the displayed QR code.

### Option 2: Docker Compose
```bash
docker compose up --build
```
Open [http://localhost:3001](http://localhost:3001).

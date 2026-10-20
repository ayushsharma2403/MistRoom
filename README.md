# MistRoom – Privacy-First Anonymous Emergency Mesh Chat

> **Tech Stack:** Python 3.11 (FastAPI, uvicorn), WebSockets, WebCrypto E2EE (AES-256-GCM), WebRTC P2P Voice & DataChannels, Docker

MistRoom is an offline-capable, privacy-first emergency communication application designed for disaster relief, crisis zones, women's safety, and local network mesh messaging. It operates completely memory-only by design: zero database, zero cloud access, no user accounts, and zero persistent storage of messages or user IP addresses.

---

## 📁 Clean Directory Architecture

```
.
├── backend/
│   ├── ai.py             # Pure Python offline NLP triage engine and vital extraction
│   ├── config.py         # Port and directory path configuration
│   ├── routes.py         # REST routes (/qr.svg, /api/info, /sw.js) and LAN IP detection
│   ├── server.py         # FastAPI application, GZip middleware, static asset mounting
│   ├── state.py          # In-memory clients, history, and message deduplication
│   └── ws_handlers.py    # WebSocket event handlers (join, switch_room, msg, signaling, ghost, etc.)
├── frontend/
│   ├── index.html        # Clean, accessible UI with passkey setup & emergency controls
│   ├── style.css         # Responsive CSS with automatic system light/dark theme
│   ├── app.js            # ES module coordinator and event wiring
│   ├── sw.js             # Service Worker for offline asset caching
│   ├── build-id.txt      # Current asset bundle build identifier
│   ├── manifest.json     # PWA Web App Manifest
│   ├── js/
│   │   ├── badges.js           # Cryptographic badges & verification
│   │   ├── bootstrap.js        # Startup initialization
│   │   ├── calls.js            # 1-on-1 WebRTC P2P voice calling
│   │   ├── crypto.js           # noble XChaCha20-Poly1305, PBKDF2 600,000 iterations, Ed25519 identity, challenge join, v2 envelopes
│   │   ├── files.js            # Encrypted P2P chunked file transfer
│   │   ├── harassment_log.js   # Tamper-evident incident logging
│   │   ├── inbound.js          # Inbound message parsing and routing
│   │   ├── mesh.js             # WebRTC RTCDataChannel mesh networking
│   │   ├── outbox.js           # IndexedDB offline store-and-forward outbox
│   │   ├── pairing_code.js     # Serverless SAS pairing code generation & parsing
│   │   ├── safewalk.js         # SafeWalk dead-man beacon & countdown
│   │   ├── settings.js         # Mnemonic seed recovery & ghost mode settings
│   │   ├── state.js            # Centralized frontend state and DOM helpers
│   │   ├── transport.js        # Unified transport abstraction layer
│   │   ├── triage.js           # Client-side emergency & safety triage
│   │   ├── ui.js               # DOM message rendering and peer lists
│   │   ├── ws.js               # WebSocket client relay and signaling
│   │   └── ble/
│   │       ├── plugin_interface.js # BLE peripheral plugin interface
│   │       ├── protocol.js         # BLE packet framing & fragmentation
│   │       └── transport_ble.js    # BLE transport provider
│   └── vendor/
│       ├── jsqr.js             # Pure JS QR code reading library
│       ├── noble-crypto.js     # Vendored @noble/ciphers & curves crypto bundle
│       ├── qrcode.js           # QR code generation library
│       └── wordlist.txt        # BIP-39 mnemonic wordlist
├── native/
│   ├── capacitor.config.ts     # Capacitor mobile configuration
│   ├── android/                # Android BLE peripheral plugin implementation
│   └── ios/                    # iOS BLE peripheral plugin implementation
├── shared/
│   └── triage_rules.json       # Common multilingual triage rules
├── tests/
│   ├── test_beacons.py         # Beacon & SafeWalk tests
│   ├── test_dedupe.py          # Message deduplication tests
│   ├── test_features_prompt7.py# Feature integration tests
│   ├── test_file_rate.py       # P2P file transfer rate limiting tests
│   ├── test_ghost.py           # Ephemeral ghost mode tests
│   ├── test_http_cache.py      # HTTP cache-control header tests
│   ├── test_ids.py             # Frontend DOM ID collision tests
│   ├── test_not_joined.py      # Pre-join state isolation tests
│   ├── test_packaging.py       # Package & docker layout tests
│   ├── test_security.py        # Security & input validation tests
│   ├── test_serverless_pairing.py # Serverless pairing tests
│   ├── test_signaling.py       # WebRTC signaling validation tests
│   ├── test_triage.py          # Pytest NLP triage regression suite
│   ├── test_ws.py              # Pytest WebSocket integration tests
│   └── e2e/
│       ├── test_csp_clean.py       # CSP violation & modal viewport tests
│       ├── test_no_webrtc.py       # WebRTC fallback degradation tests
│       ├── test_playwright_e2e.py  # Playwright automated E2E browser tests
│       └── test_serverless_e2e.py  # Serverless WebRTC data channel E2E tests
├── tools/
│   ├── bench.py                # WebSocket connection & latency benchmark
│   ├── build_assets.py         # Asset cache-busting & sw build-id script
│   ├── check_ids.py            # Unique DOM ID checker
│   ├── extract_inline_styles.py# Inline CSS CSP extractor
│   ├── issue_badge.py          # Offline Ed25519 badge issuance tool
│   ├── make_authority_key.py   # Authority Ed25519 keypair generator
│   ├── revoke_badge.py         # Badge revocation helper
│   └── verify_log.py           # Harassment log verification utility
├── docker-compose.yml          # Single web service orchestration
├── Dockerfile                  # Container build for FastAPI backend
├── requirements.txt            # Python dependencies
└── README.md
```

---

## 🌟 Key Architecture & Features

1. **Client-Side Cryptography**:
   noble XChaCha20-Poly1305, PBKDF2 600,000 iterations, Ed25519 identity, challenge join, v2 envelopes. All encryption, decryption, and identity signing occur directly in the browser. Central servers and network sniffers only see opaque encrypted envelopes.

2. **Strictly In-Memory Zero-Logging Backend**:
   The FastAPI server keeps state in memory only. Zero databases, zero user identities, zero IP addresses, and zero plaintext are ever stored on disk. When the process exits, all ephemeral relay state disappears.

3. **Offline Peer-to-Peer Mesh (WebRTC `RTCDataChannel`)**:
   Peers automatically establish browser-to-browser P2P data channels (`mistmesh`) and voice calls. If the central server drops, connected peers continue communicating uninterrupted.

4. **Offline Rule-Based NLP Triage Engine**:
   Pure Python offline triage engine supporting English, Hindi, and Hinglish disaster and emergency vocabulary. Automatically classifies SOS, Medical, Logistics, Shelter, and Women's Safety priorities with real-time severity scoring (0–3) and vital signal extraction.

---

## 🧪 Running Tests

To run the Python backend and integration test suite:

```bash
# Run unit and integration tests (excluding browser E2E):
python -m pytest tests -q --ignore=tests/e2e

# Run all tests including Playwright E2E:
python -m pytest tests -q
```

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

# MistRoom – Privacy-First Anonymous Chat Application

> **Tech Stack:** Python (FastAPI), WebSockets, End-to-End Encryption (AES-256-GCM), MySQL, WebRTC Mesh, Docker Compose

MistRoom is an offline-capable, privacy-first emergency communication application designed for disaster relief and local network mesh messaging. It requires no central cloud, no user accounts, and enforces a strict zero-logging design.

---

## 🌟 Key Highlights & Architecture

- **End-to-End Encryption (E2EE) & Zero-Logging**:
  Client-side AES-256-GCM encryption using the native Web Crypto API (`window.crypto.subtle`) with PBKDF2 key derivation. All chat messages are encrypted directly in the browser before transmission; servers and intermediate proxies only relay and store opaque ciphertext and initialization vectors (`iv`), making messages completely unreadable to the backend.
- **Offline Peer-to-Peer Mesh Networking Mode**:
  Built-in WebRTC `RTCDataChannel` mesh topology. While the server acts as an initial signaling broker, connected peers establish direct browser-to-browser data links. If the central server drops or the Wi-Fi AP fails, mesh peers continue exchanging messages directly.
- **MySQL Ephemeral Data Layer**:
  Containerized with MySQL 8.0 to manage active peer presence and zero-knowledge encrypted message caches with zero user identity or IP logging.
- **On-Device Offline AI Emergency Intelligence**:
  Offline natural language triage engine supporting multilingual emergency keywords (English, Hindi, Hinglish), urgency modifiers, priority classification (SOS / Medical / Rations / Shelter), and real-time situational report summarization for rescue teams.
- **Docker Compose Containerization**:
  Packaged with a multi-container Docker Compose setup (`web` and `db`) for reproducible one-command deployment.

---

## 🚀 Quick Start

### Option 1: Docker Compose (Recommended)

Run the full stack (FastAPI backend + MySQL 8.0 database) with a single command:

```bash
docker compose up --build
```
Open [http://localhost:3000](http://localhost:3000) on the host machine.

---

### Option 2: Standalone Local Run (Pure Python)

MistRoom includes automated graceful fallback to in-memory mode if MySQL is not running locally:

```bash
pip install -r requirements.txt
python server.py
```
Open [http://localhost:3000](http://localhost:3000). Other devices on the same Wi-Fi / hotspot can join using the LAN IP address or the displayed QR code.

---

## 📁 Project Structure

- `server.py`: FastAPI backend, WebSocket relay, WebRTC signaling hub, and async MySQL connector.
- `ai.py`: Offline rule-based NLP triage and situation report generator.
- `init.sql`: MySQL database schema for rooms, active peer sessions, and encrypted caches.
- `Dockerfile` & `docker-compose.yml`: Containerization setup for app and MySQL services.
- `public/`:
  - `index.html`: Responsive chat interface, E2EE passkey modal, peer radar, and privacy status badges.
  - `app.js`: Web Crypto API E2EE engine, WebRTC DataChannel mesh manager, and client-side triage.
  - `manifest.json`: Web app manifest for PWA installation.

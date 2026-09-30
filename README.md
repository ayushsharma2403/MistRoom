# MistRoom (Python backend)

Offline emergency chat with on-device AI. No internet, no accounts, no cloud.

## Run
1. Install Python 3.10+ (python.org, tick "Add to PATH").
2. In the project folder:  `pip install -r requirements.txt`  then  `python server.py`
3. Allow Python through Windows Firewall (Private networks).
4. Connect the PC and phones to the same hotspot/Wi-Fi. Restart `python server.py`.
5. Open http://localhost:3000 on the PC. Guests scan the QR code or open the printed address.

## Files
- server.py: FastAPI + WebSocket backend (relay, duplicate drop, history, people list, QR)
- ai.py: emergency triage and situation summary (pure Python, offline)
- public/: web app (index.html, app.js, manifest.json)

## Limits (say this in the pitch)
Needs a shared Wi-Fi/hotspot, not Bluetooth. Encryption and offline install need https (future work).

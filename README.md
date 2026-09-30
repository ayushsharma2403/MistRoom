# MistRoom

Offline emergency chat with on-device AI. No internet, no accounts, no cloud.

## Run (2 minutes)
1. Install Node.js (nodejs.org), open this folder in Antigravity.
2. Terminal: `npm install` then `npm start`
3. Turn on a phone hotspot (or a router with no internet), join it with the laptop.
4. Restart `npm start` so it prints the right address. Open `http://localhost:3000/qr.svg`
   (or the join screen on the host) and let guests scan the QR code.
5. Guests open the link in any phone or PC browser, pick a nickname, and chat.

## Files
- server.js: HTTP + WebSocket relay, duplicate suppression, history, presence
- public/ai.js: emergency triage + situation summary (offline)
- public/app.js, index.html: chat UI, SOS, people radar, panic wipe (tap logo 3x)

## Limits (be honest in the pitch)
- Needs everyone on the same Wi-Fi/hotspot. Not Bluetooth.
- Browsers only allow service workers and Web Crypto on HTTPS/localhost, so offline
  install and encryption are stretch goals, not included.

## 3-day plan
- Day 1: run it, test on 2-3 devices, fix anything Antigravity flags. Change names/colors so it is yours.
- Day 2: improve ai.js (add words for your language), test SOS and summary, try a real hotspot demo.
- Day 3: polish UI, record demo video, write slides. Optional: a second relay server.

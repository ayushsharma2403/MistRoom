// MistRoom server: serves the web app and relays messages over WebSocket.
// Works on a local Wi-Fi / hotspot with NO internet.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { WebSocketServer } = require('ws');
const QR = require('qrcode');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function lanIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
const URL_ = `http://${lanIp()}:${PORT}`;

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/qr.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(await QR.toString(URL_, { type: 'svg', margin: 1 }));
  }
  if (url === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ url: URL_ }));
  }
  const file = path.join(PUB, url === '/' ? 'index.html' : url);
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const seen = new Set();   // message ids already relayed (duplicate suppression)
const history = [];       // last 100 messages, so late joiners catch up
const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
const broadcast = obj => wss.clients.forEach(c => send(c, obj));

function sendPeople() {
  const people = [...wss.clients].filter(c => c.name).map(c => ({ name: c.name, joined: c.joined }));
  broadcast({ t: 'people', people });
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join') {
      ws.name = String(m.name || 'guest').slice(0, 20);
      ws.joined = Date.now();
      send(ws, { t: 'history', history });
      sendPeople();
    } else if (m.t === 'msg' && ws.name) {
      if (!m.id || seen.has(m.id)) return;               // drop duplicates
      seen.add(m.id);
      const msg = { id: m.id, from: ws.name, text: String(m.text || '').slice(0, 500),
                    cat: m.cat || 'general', prio: m.prio || 0, ts: Date.now() };
      history.push(msg); if (history.length > 100) history.shift();
      broadcast({ t: 'msg', msg });
    }
  });
  ws.on('close', sendPeople);
});

// drop dead connections every 15 s
setInterval(() => wss.clients.forEach(c => {
  if (!c.isAlive) return c.terminate();
  c.isAlive = false; c.ping();
}), 15000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nMistRoom is running.');
  console.log('Open on the host:   http://localhost:' + PORT);
  console.log('Guests join at:     ' + URL_);
  console.log('QR code page:       http://localhost:' + PORT + '/qr.svg\n');
});

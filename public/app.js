const $ = id => document.getElementById(id);
let ws, me = localStorage.getItem('mr_name') || '', all = [], retry = 0;
const LABEL = { sos: 'SOS', medical: 'Medical', water: 'Water/Food', shelter: 'Shelter', general: '' };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Show QR only on the host machine (localhost) so guests don't see it.
if (['localhost', '127.0.0.1'].includes(location.hostname)) $('qrbox').hidden = false;
$('name').value = me;
$('go').onclick = join;
$('name').onkeydown = e => e.key === 'Enter' && join();

function join() {
  const n = $('name').value.trim();
  if (!n) return $('name').focus();
  me = n; localStorage.setItem('mr_name', me);
  $('join').style.display = 'none';
  connect();
}
if (me) { $('join').style.display = 'none'; connect(); }

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { retry = 0; setStatus(true); ws.send(JSON.stringify({ t: 'join', name: me })); };
  ws.onclose = () => { setStatus(false); setTimeout(connect, Math.min(1000 * ++retry, 5000)); };
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.t === 'history') { all = d.history; render(); }
    if (d.t === 'msg') { all.push(d.msg); add(d.msg); pin(); }
    if (d.t === 'people') people(d.people);
    if (d.t === 'summary') sys('Summary: ' + d.text);
  };
}
function setStatus(on) { $('dot').className = 'dot' + (on ? ' on' : ''); $('st').textContent = on ? 'Connected' : 'Reconnecting'; }

function add(m, scroll = true) {
  const d = document.createElement('div');
  d.className = 'msg ' + m.cat + (m.from === me ? ' me' : '');
  const meta = document.createElement('div'); meta.className = 'meta';
  const who = document.createElement('span'); who.textContent = m.from === me ? 'You' : m.from;
  const time = document.createElement('span'); time.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.append(who, time);
  if (LABEL[m.cat]) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = LABEL[m.cat]; meta.append(t); }
  const body = document.createElement('div'); body.textContent = m.text;  // textContent = safe from HTML injection
  d.append(meta, body);
  $('list').append(d);
  if (scroll) $('list').scrollTop = $('list').scrollHeight;
}
function render() { $('list').innerHTML = ''; all.forEach(m => add(m, false)); $('list').scrollTop = 1e9; pin(); }
function pin() {
  const sos = all.filter(m => m.cat === 'sos').slice(-1)[0];
  $('pinned').style.display = sos ? 'block' : 'none';
  if (sos) $('pinned').textContent = 'SOS from ' + sos.from + ': ' + sos.text.slice(0, 80);
}
function sys(t) { const d = document.createElement('div'); d.className = 'sys'; d.textContent = t; $('list').append(d); $('list').scrollTop = 1e9; }

function post(text, sos) {
  if (!text || !ws || ws.readyState !== 1) return sys('Not connected yet. Wait for the green dot.');
  ws.send(JSON.stringify({ t: 'msg', id: uid(), text, sos: !!sos }));  // Python backend does the AI tagging
}
$('f').onsubmit = e => { e.preventDefault(); post($('text').value.trim()); $('text').value = ''; };
$('sos').onclick = () => post('SOS! I need help. ' + ($('text').value.trim() || ''), true);
$('sum').onclick = () => ws && ws.readyState === 1 && ws.send(JSON.stringify({ t: 'summary' }));
$('showp').onclick = () => { const s = $('side'); s.style.cssText = s.style.display === 'block' ? '' : 'display:block;position:fixed;right:0;top:54px;bottom:0;z-index:4'; };

function people(list) {
  $('count').textContent = '(' + list.length + ')';
  $('people').innerHTML = '';
  $('radar').innerHTML = '';
  list.forEach((p, i) => {
    const li = document.createElement('li'); li.textContent = (p.name === me ? p.name + ' (you)' : p.name); $('people').append(li);
    const b = document.createElement('b'); if (p.name === me) b.className = 'you';
    const a = (i / Math.max(list.length, 1)) * 6.283, r = p.name === me ? 0 : 28 + (i % 3) * 10;
    b.style.left = 50 + r * Math.cos(a) + '%'; b.style.top = 50 + r * Math.sin(a) + '%';
    $('radar').append(b);
  });
}

// Panic wipe: tap the logo 3 times quickly to erase everything on this device.
let taps = [];
$('logo').onclick = () => {
  const n = Date.now(); taps = taps.filter(t => n - t < 900); taps.push(n);
  if (taps.length >= 3) { localStorage.clear(); all = []; $('list').innerHTML = ''; $('pinned').style.display = 'none'; me = ''; ws && ws.close(); location.reload(); }
};

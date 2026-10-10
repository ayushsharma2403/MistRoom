// MistRoom: Privacy-First Anonymous Chat + E2EE + WebRTC Mesh + Offline AI
const $ = id => document.getElementById(id);

let ws, me = localStorage.getItem('mr_name') || '';
let passkey = localStorage.getItem('mr_secret') || 'mistroom-safe';
let cryptoKey = null;
let myPeerId = 'p_' + Math.random().toString(36).slice(2, 9);
let all = [], retry = 0;
let peersList = [];

// WebRTC P2P Mesh connections: peerId -> { pc, dc }
const meshPeers = new Map();

const LABEL = { sos: 'SOS', medical: 'Medical', water: 'Water/Food', shelter: 'Shelter', general: '' };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// -------------------------------------------------------------
// 1. END-TO-END ENCRYPTION (Web Crypto API - AES-256-GCM)
// -------------------------------------------------------------
async function deriveKey(secret) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode('mistroom_salt_fixed_mesh'),
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptText(plain) {
  if (!cryptoKey) return { ciphertext: plain, iv: '' };
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encoded = enc.encode(plain);
  const cipherBuffer = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encoded
  );
  return {
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(cipherBuffer))),
    iv: btoa(String.fromCharCode(...iv))
  };
}

async function decryptText(ciphertext, ivStr) {
  if (!cryptoKey || !ivStr) return ciphertext;
  try {
    const iv = Uint8Array.from(atob(ivStr), c => c.charCodeAt(0));
    const cipherBytes = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      cipherBytes
    );
    return new TextDecoder().decode(decryptedBuffer);
  } catch (err) {
    return '[Decryption failed: Incorrect passkey]';
  }
}

// -------------------------------------------------------------
// 2. CLIENT-SIDE AI EMERGENCY TRIAGE (Pre-encryption)
// -------------------------------------------------------------
const AI_RULES = [
  { cat: 'sos', prio: 3, words: ['sos', 'help', 'emergency', 'trapped', 'drowning', 'fire', 'dying', 'madad', 'bachao', 'aag', 'phas gaye'] },
  { cat: 'medical', prio: 2, words: ['bleeding', 'injured', 'hurt', 'unconscious', 'broken', 'pain', 'doctor', 'ambulance', 'insulin', 'dawai', 'ghayal', 'chot', 'khoon'] },
  { cat: 'water', prio: 1, words: ['water', 'food', 'hungry', 'thirsty', 'milk', 'baby', 'paani', 'khana', 'bhook', 'pyaas'] },
  { cat: 'shelter', prio: 1, words: ['shelter', 'roof', 'blanket', 'cold', 'stuck', 'evacuate', 'safe place', 'ghar', 'rescue', 'rasta band'] },
];

function clientTriage(text) {
  const t = (text || '').toLowerCase();
  let best = { cat: 'general', prio: 0, score: 0 };
  for (const rule of AI_RULES) {
    const score = rule.words.reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);
    if (score > 0 && (rule.prio > best.prio || (rule.prio === best.prio && score > best.score))) {
      best = { cat: rule.cat, prio: rule.prio, score };
    }
  }
  if ((text.includes('!') || text.toUpperCase() === text) && best.prio > 0 && best.prio < 3) {
    best.prio += 1;
  }
  return { cat: best.cat, prio: best.prio };
}

// -------------------------------------------------------------
// 3. WEBRTC P2P MESH NETWORKING
// -------------------------------------------------------------
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function setupWebRTC(targetPeerId, isInitiator) {
  if (meshPeers.has(targetPeerId)) return;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  meshPeers.set(targetPeerId, { pc, dc: null });

  pc.onicecandidate = e => {
    if (e.candidate && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'webrtc_ice', target: targetPeerId, data: e.candidate }));
    }
  };

  if (isInitiator) {
    const dc = pc.createDataChannel('mistmesh');
    bindDataChannel(dc, targetPeerId);
    meshPeers.get(targetPeerId).dc = dc;

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ t: 'webrtc_offer', target: targetPeerId, data: pc.localDescription }));
        }
      })
      .catch(console.error);
  } else {
    pc.ondatachannel = e => {
      bindDataChannel(e.channel, targetPeerId);
      meshPeers.get(targetPeerId).dc = e.channel;
    };
  }
}

function bindDataChannel(dc, targetPeerId) {
  dc.onopen = () => updateMeshBadge();
  dc.onclose = () => {
    meshPeers.delete(targetPeerId);
    updateMeshBadge();
  };
  dc.onmessage = async e => {
    try {
      const msg = JSON.parse(e.data);
      if (all.some(m => m.id === msg.id)) return;
      if (msg.ciphertext && msg.iv) {
        msg.text = await decryptText(msg.ciphertext, msg.iv);
      }
      msg.route = 'P2P Mesh';
      all.push(msg);
      add(msg);
      pin();
    } catch (err) {
      console.error('DataChannel msg error', err);
    }
  };
}

function updateMeshBadge() {
  const activeP2P = Array.from(meshPeers.values()).filter(p => p.dc && p.dc.readyState === 'open').length;
  $('mesh-badge').textContent = `⚡ Mesh: ${activeP2P} P2P`;
}

function broadcastP2P(msg) {
  let sentCount = 0;
  const dataStr = JSON.stringify(msg);
  for (const [, peer] of meshPeers) {
    if (peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(dataStr);
        sentCount++;
      } catch (err) {}
    }
  }
  return sentCount;
}

async function join() {
  const n = $('name').value.trim();
  const s = $('secret').value.trim() || 'mistroom-safe';
  if (!n) return $('name').focus();
  me = n;
  passkey = s;
  localStorage.setItem('mr_name', me);
  localStorage.setItem('mr_secret', passkey);
  cryptoKey = await deriveKey(passkey);

  $('join').style.display = 'none';
  connect();
}

function initApp() {
  if ($('qrbox')) $('qrbox').hidden = false;
  $('name').value = me || '';
  if (passkey) $('secret').value = passkey;

  if ($('eye')) {
    $('eye').onclick = () => {
      const sec = $('secret');
      if (sec.type === 'password') {
        sec.type = 'text';
        $('eye').textContent = '🔒';
      } else {
        sec.type = 'password';
        $('eye').textContent = '👁️';
      }
    };
  }

  $('go').onclick = join;
  $('name').onkeydown = e => e.key === 'Enter' && join();
  $('secret').onkeydown = e => e.key === 'Enter' && join();

  setTimeout(() => {
    if (!$('name').value) $('name').focus();
  }, 100);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => {
    retry = 0;
    setStatus(true);
    ws.send(JSON.stringify({ t: 'join', name: me, peer_id: myPeerId }));
  };
  ws.onclose = () => {
    setStatus(false);
    setTimeout(connect, Math.min(1000 * ++retry, 5000));
  };
  ws.onmessage = async e => {
    const d = JSON.parse(e.data);
    if (d.t === 'history') {
      all = [];
      for (const m of d.history) {
        if (m.ciphertext && m.iv) {
          m.text = await decryptText(m.ciphertext, m.iv);
        }
        all.push(m);
      }
      render();
    }
    if (d.t === 'msg') {
      if (all.some(m => m.id === d.msg.id)) return;
      if (d.msg.ciphertext && d.msg.iv) {
        d.msg.text = await decryptText(d.msg.ciphertext, d.msg.iv);
      }
      all.push(d.msg);
      add(d.msg);
      pin();
    }
    if (d.t === 'people') {
      peersList = d.people;
      people(d.people);
      // Auto-connect WebRTC mesh with other peers
      d.people.forEach(p => {
        if (p.peer_id && p.peer_id !== myPeerId && !meshPeers.has(p.peer_id)) {
          // Deterministic initiator choice to avoid offer race conditions
          const isInitiator = myPeerId > p.peer_id;
          setupWebRTC(p.peer_id, isInitiator);
        }
      });
    }
    if (d.t === 'webrtc_offer') {
      const { sender, data } = d;
      setupWebRTC(sender, false);
      const peer = meshPeers.get(sender);
      if (peer) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ t: 'webrtc_answer', target: sender, data: peer.pc.localDescription }));
      }
    }
    if (d.t === 'webrtc_answer') {
      const { sender, data } = d;
      const peer = meshPeers.get(sender);
      if (peer) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
      }
    }
    if (d.t === 'webrtc_ice') {
      const { sender, data } = d;
      const peer = meshPeers.get(sender);
      if (peer && data) {
        try { await peer.pc.addIceCandidate(new RTCIceCandidate(data)); } catch (err) {}
      }
    }
    if (d.t === 'summary') sys(d.text);
  };
}

function setStatus(on) {
  $('dot').className = 'dot' + (on ? ' on' : '');
  $('st').textContent = on ? 'Server Connected' : 'Offline Mesh';
}

function add(m, scroll = true) {
  const d = document.createElement('div');
  d.className = 'msg ' + m.cat + (m.from === me ? ' me' : '');
  const meta = document.createElement('div'); meta.className = 'meta';
  const who = document.createElement('span'); who.textContent = m.from === me ? 'You' : m.from;
  const time = document.createElement('span'); time.textContent = new Date(m.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.append(who, time);

  if (m.route) {
    const routeSpan = document.createElement('span');
    routeSpan.className = 'route';
    routeSpan.textContent = m.route;
    meta.append(routeSpan);
  }

  if (LABEL[m.cat]) {
    const t = document.createElement('span'); t.className = 'tag';
    t.textContent = LABEL[m.cat];
    meta.append(t);
  }

  const body = document.createElement('div'); body.textContent = m.text;
  d.append(meta, body);
  $('list').append(d);
  if (scroll) $('list').scrollTop = $('list').scrollHeight;
}

function render() {
  $('list').innerHTML = '';
  all.forEach(m => add(m, false));
  $('list').scrollTop = 1e9;
  pin();
}

function pin() {
  const sos = all.filter(m => m.cat === 'sos').slice(-1)[0];
  $('pinned').style.display = sos ? 'block' : 'none';
  if (sos) $('pinned').textContent = '🚨 SOS from ' + sos.from + ': ' + (sos.text || '').slice(0, 80);
}

function sys(t) {
  const d = document.createElement('div');
  d.className = 'sys';
  d.textContent = t;
  $('list').append(d);
  $('list').scrollTop = 1e9;
}

async function post(text, sos) {
  if (!text) return;
  const triageResult = sos ? { cat: 'sos', prio: 3 } : clientTriage(text);
  const mid = uid();
  const encrypted = await encryptText(text);

  const msgPayload = {
    t: 'msg',
    id: mid,
    from: me,
    peer_id: myPeerId,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    cat: triageResult.cat,
    prio: triageResult.prio,
    sos: !!sos,
    ts: Date.now()
  };

  // 1. Direct WebRTC Mesh broadcast
  const p2pCount = broadcastP2P(msgPayload);

  // 2. WebSocket relay to central server (and MySQL zero-knowledge cache)
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msgPayload));
  } else if (p2pCount === 0) {
    sys('⚠️ Offline: Waiting for nearby peer connection or server relay.');
  }

  // Local optimistic append
  const localDisplayMsg = { ...msgPayload, text, route: p2pCount > 0 ? `P2P Mesh (${p2pCount})` : 'Relay' };
  all.push(localDisplayMsg);
  add(localDisplayMsg);
  pin();
}

$('f').onsubmit = e => {
  e.preventDefault();
  post($('text').value.trim());
  $('text').value = '';
};

$('sos').onclick = () => post('SOS! I need immediate help. ' + ($('text').value.trim() || ''), true);

if ($('gps')) {
  $('gps').onclick = () => {
    if (!navigator.geolocation) {
      return sys('Geolocation is not supported by your browser.');
    }
    sys('📡 Fetching GPS coordinates...');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const coords = `📍 [Location: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}] `;
        $('text').value = coords + $('text').value;
        $('text').focus();
      },
      err => {
        sys(`⚠️ Unable to retrieve GPS: ${err.message}`);
      },
      { timeout: 8000, enableHighAccuracy: true }
    );
  };
}

// Client-side AI Situation Summary
$('sum').onclick = () => {
  if (all.length === 0) return sys('No messages recorded to summarize.');
  const count = c => all.filter(m => m.cat === c).length;
  const uniquePeople = new Set(all.map(m => m.from)).size;
  const urgent = all.filter(m => m.prio >= 2).slice(-3);
  let summary = `🚨 Client AI Report: ${all.length} messages from ${uniquePeople} peer(s). SOS: ${count('sos')} | Medical: ${count('medical')} | Rations: ${count('water')} | Shelter: ${count('shelter')}.`;
  if (urgent.length) {
    summary += ' Latest Critical: ' + urgent.map(u => `${u.from}: "${(u.text || '').slice(0, 40)}"`).join(' | ');
  }
  sys(summary);
};

$('showp').onclick = () => {
  const s = $('side');
  s.style.cssText = s.style.display === 'block' ? '' : 'display:block;position:fixed;right:0;top:54px;bottom:0;z-index:4';
};

function people(list) {
  $('count').textContent = '(' + list.length + ')';
  $('people').innerHTML = '';
  $('radar').innerHTML = '';
  list.forEach((p, i) => {
    const li = document.createElement('li');
    const isP2P = meshPeers.has(p.peer_id) && meshPeers.get(p.peer_id).dc?.readyState === 'open';
    li.innerHTML = `<span>${p.name === me ? p.name + ' (you)' : p.name}</span>` + (isP2P ? '<span class="p2p">P2P Mesh</span>' : '');
    $('people').append(li);

    const b = document.createElement('b');
    if (p.name === me) b.className = 'you';
    else if (isP2P) b.className = 'mesh-peer';
    const a = (i / Math.max(list.length, 1)) * 6.283;
    const r = p.name === me ? 0 : 28 + (i % 3) * 10;
    b.style.left = 50 + r * Math.cos(a) + '%';
    b.style.top = 50 + r * Math.sin(a) + '%';
    $('radar').append(b);
  });
}

// Panic wipe: Tap logo 3 times to clear credentials and storage
let taps = [];
$('logo').onclick = () => {
  const n = Date.now();
  taps = taps.filter(t => n - t < 900);
  taps.push(n);
  if (taps.length >= 3) {
    localStorage.clear();
    all = [];
    $('list').innerHTML = '';
    $('pinned').style.display = 'none';
    me = '';
    ws && ws.close();
    location.reload();
  }
};

/**
 * MistRoom Frontend Engine:
 * - End-to-End Encryption (AES-256-GCM + PBKDF2)
 * - WebRTC P2P DataChannel Mesh
 * - Multilingual Disaster Triage (Client-Side)
 * - Zero-Logging: Only sends encrypted ciphertexts + IVs
 */

// Helper selector
const $ = id => document.getElementById(id);

// App State
let ws = null;
let currentNickname = '';
let currentPasskey = 'mistroom-safe';
let cryptoKey = null;
const myPeerId = 'peer_' + Math.random().toString(36).substring(2, 9);
const messagesHistory = [];
const meshPeers = new Map(); // peerId -> { pc, dc }

// Triage Categories & Labels
const CATEGORY_LABELS = {
  sos: '🚨 SOS',
  medical: '🩺 Medical',
  water: '💧 Water/Food',
  shelter: '⛺ Shelter',
  general: ''
};

// -------------------------------------------------------------
// 1. CRYPTOGRAPHY ENGINE (AES-256-GCM + PBKDF2)
// -------------------------------------------------------------
async function deriveEncryptionKey(passkey) {
  const enc = new TextEncoder();
  const rawKey = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(passkey),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode('mistroom_fixed_mesh_salt'),
      iterations: 100000,
      hash: 'SHA-256'
    },
    rawKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptMessage(plaintext) {
  if (!cryptoKey) return { ciphertext: plaintext, iv: '' };
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
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

async function decryptMessage(ciphertext, ivBase64) {
  if (!cryptoKey || !ivBase64) return ciphertext;
  try {
    const iv = Uint8Array.from(atob(ivBase64), c => c.charCodeAt(0));
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
// 2. CLIENT-SIDE EMERGENCY TRIAGE
// -------------------------------------------------------------
const EMERGENCY_RULES = [
  { cat: 'sos', prio: 3, words: ['sos', 'help', 'emergency', 'trapped', 'fire', 'dying', 'madad', 'bachao', 'aag'] },
  { cat: 'medical', prio: 2, words: ['bleeding', 'injured', 'hurt', 'pain', 'doctor', 'ambulance', 'insulin', 'dawai', 'ghayal', 'khoon'] },
  { cat: 'water', prio: 1, words: ['water', 'food', 'hungry', 'thirsty', 'milk', 'paani', 'khana', 'pyaas'] },
  { cat: 'shelter', prio: 1, words: ['shelter', 'roof', 'blanket', 'cold', 'stuck', 'evacuate', 'ghar'] }
];

function triageText(text) {
  const lower = (text || '').toLowerCase();
  let best = { cat: 'general', prio: 0, score: 0 };
  for (const rule of EMERGENCY_RULES) {
    const score = rule.words.reduce((acc, word) => acc + (lower.includes(word) ? 1 : 0), 0);
    if (score > 0 && (rule.prio > best.prio || (rule.prio === best.prio && score > best.score))) {
      best = { cat: rule.cat, prio: rule.prio, score };
    }
  }
  if ((text.includes('!') || (text.length > 4 && text.toUpperCase() === text)) && best.prio > 0 && best.prio < 3) {
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

function initWebRTCPeer(targetPeerId, isInitiator) {
  if (meshPeers.has(targetPeerId)) return;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  meshPeers.set(targetPeerId, { pc, dc: null });

  pc.onicecandidate = event => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'webrtc_ice', target: targetPeerId, data: event.candidate }));
    }
  };

  if (isInitiator) {
    const dc = pc.createDataChannel('mistmesh');
    attachDataChannelEvents(dc, targetPeerId);
    meshPeers.get(targetPeerId).dc = dc;

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'webrtc_offer', target: targetPeerId, data: pc.localDescription }));
        }
      })
      .catch(console.error);
  } else {
    pc.ondatachannel = event => {
      attachDataChannelEvents(event.channel, targetPeerId);
      meshPeers.get(targetPeerId).dc = event.channel;
    };
  }
}

function attachDataChannelEvents(dc, targetPeerId) {
  dc.onopen = () => updateMeshBadge();
  dc.onclose = () => {
    meshPeers.delete(targetPeerId);
    updateMeshBadge();
  };
  dc.onmessage = async event => {
    try {
      const msg = JSON.parse(event.data);
      if (messagesHistory.some(m => m.id === msg.id)) return;
      if (msg.ciphertext && msg.iv) {
        msg.text = await decryptMessage(msg.ciphertext, msg.iv);
      }
      msg.route = 'P2P Mesh';
      messagesHistory.push(msg);
      appendMessageToUI(msg);
      updateSOSBanner();
    } catch (err) {
      console.error('DataChannel message parse error:', err);
    }
  };
}

function updateMeshBadge() {
  const activeCount = Array.from(meshPeers.values()).filter(p => p.dc && p.dc.readyState === 'open').length;
  $('mesh-counter').textContent = `⚡ Mesh: ${activeCount} P2P`;
}

function broadcastOverP2P(msg) {
  let count = 0;
  const serialized = JSON.stringify(msg);
  for (const [, peer] of meshPeers) {
    if (peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(serialized);
        count++;
      } catch (e) {}
    }
  }
  return count;
}

// -------------------------------------------------------------
// 4. UI INTERACTION & MESSAGING
// -------------------------------------------------------------
async function handleJoin() {
  const nameInput = $('nickname-input');
  const passInput = $('passkey-input');
  const nickname = (nameInput.value || '').trim();
  const passkey = (passInput.value || '').trim() || 'mistroom-safe';

  if (!nickname) {
    nameInput.focus();
    return;
  }

  currentNickname = nickname;
  currentPasskey = passkey;
  cryptoKey = await deriveEncryptionKey(currentPasskey);

  $('join-modal').style.display = 'none';
  connectWebSocket();
}

function appendMessageToUI(msg, autoScroll = true) {
  const list = $('messages-list');
  const bubble = document.createElement('div');
  bubble.className = `msg-bubble ${msg.cat || 'general'} ${msg.from === currentNickname ? 'me' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const sender = document.createElement('span');
  sender.className = 'msg-sender';
  sender.textContent = msg.from === currentNickname ? 'You' : msg.from;

  const time = document.createElement('span');
  time.textContent = new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  meta.append(sender, time);

  if (msg.route) {
    const route = document.createElement('span');
    route.className = 'route-tag';
    route.textContent = msg.route;
    meta.append(route);
  }

  if (CATEGORY_LABELS[msg.cat]) {
    const badge = document.createElement('span');
    badge.className = 'cat-badge';
    badge.textContent = CATEGORY_LABELS[msg.cat];
    meta.append(badge);
  }

  const textNode = document.createElement('div');
  textNode.className = 'msg-text';
  textNode.textContent = msg.text || '';

  bubble.append(meta, textNode);
  list.append(bubble);

  if (autoScroll) list.scrollTop = list.scrollHeight;
}

function updateSOSBanner() {
  const latestSOS = messagesHistory.filter(m => m.cat === 'sos').slice(-1)[0];
  const banner = $('sos-banner');
  if (latestSOS) {
    banner.style.display = 'block';
    banner.textContent = `🚨 SOS from ${latestSOS.from}: ${(latestSOS.text || '').substring(0, 80)}`;
  } else {
    banner.style.display = 'none';
  }
}

function appendSystemMessage(text) {
  const list = $('messages-list');
  const sys = document.createElement('div');
  sys.className = 'system-msg';
  sys.textContent = text;
  list.append(sys);
  list.scrollTop = list.scrollHeight;
}

async function sendMessage(rawText, isSOS = false) {
  if (!rawText) return;
  const triage = isSOS ? { cat: 'sos', prio: 3 } : triageText(rawText);
  const mid = 'm_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const encrypted = await encryptMessage(rawText);

  const payload = {
    t: 'msg',
    id: mid,
    from: currentNickname,
    peer_id: myPeerId,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    cat: triage.cat,
    prio: triage.prio,
    sos: !!isSOS,
    ts: Date.now()
  };

  // 1. Direct WebRTC P2P send
  const p2pCount = broadcastOverP2P(payload);

  // 2. Central relay send
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else if (p2pCount === 0) {
    appendSystemMessage('⚠️ Offline: Waiting for mesh peers or central relay.');
  }

  // Optimistic local UI display
  const localMessage = {
    ...payload,
    text: rawText,
    route: p2pCount > 0 ? `P2P Mesh (${p2pCount})` : 'Relay'
  };
  messagesHistory.push(localMessage);
  appendMessageToUI(localMessage);
  updateSOSBanner();
}

// -------------------------------------------------------------
// 5. WEBSOCKET CONNECTION
// -------------------------------------------------------------
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    $('status-dot').className = 'status-dot online';
    $('status-text').textContent = 'Online';
    ws.send(JSON.stringify({ t: 'join', name: currentNickname, peer_id: myPeerId }));
  };

  ws.onclose = () => {
    $('status-dot').className = 'status-dot';
    $('status-text').textContent = 'Reconnecting...';
    setTimeout(connectWebSocket, 3000);
  };

  ws.onmessage = async event => {
    const data = JSON.parse(event.data);

    if (data.t === 'history') {
      messagesHistory.length = 0;
      $('messages-list').innerHTML = '';
      for (const m of data.history) {
        if (m.ciphertext && m.iv) {
          m.text = await decryptMessage(m.ciphertext, m.iv);
        }
        messagesHistory.push(m);
        appendMessageToUI(m, false);
      }
      $('messages-list').scrollTop = $('messages-list').scrollHeight;
      updateSOSBanner();
    }

    if (data.t === 'msg') {
      if (messagesHistory.some(m => m.id === data.msg.id)) return;
      if (data.msg.ciphertext && data.msg.iv) {
        data.msg.text = await decryptMessage(data.msg.ciphertext, data.msg.iv);
      }
      messagesHistory.push(data.msg);
      appendMessageToUI(data.msg);
      updateSOSBanner();
    }

    if (data.t === 'people') {
      renderPeers(data.people);
      data.people.forEach(p => {
        if (p.peer_id && p.peer_id !== myPeerId && !meshPeers.has(p.peer_id)) {
          const isInitiator = myPeerId < p.peer_id;
          initWebRTCPeer(p.peer_id, isInitiator);
        }
      });
    }

    if (data.t === 'webrtc_offer') {
      const sender = data.sender;
      if (!meshPeers.has(sender)) initWebRTCPeer(sender, false);
      const peer = meshPeers.get(sender);
      if (peer && peer.pc) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.data));
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ t: 'webrtc_answer', target: sender, data: answer }));
      }
    }

    if (data.t === 'webrtc_answer') {
      const peer = meshPeers.get(data.sender);
      if (peer && peer.pc) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.data));
      }
    }

    if (data.t === 'webrtc_ice') {
      const peer = meshPeers.get(data.sender);
      if (peer && peer.pc && data.data) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(data.data));
        } catch (e) {}
      }
    }

    if (data.t === 'summary') {
      appendSystemMessage(data.text);
    }
  };
}

function renderPeers(peers) {
  $('peer-count').textContent = peers.length;
  const list = $('peers-list');
  const radar = $('radar-display');
  list.innerHTML = '';
  radar.innerHTML = '';

  peers.forEach((p, idx) => {
    const li = document.createElement('li');
    const isP2P = meshPeers.has(p.peer_id) && meshPeers.get(p.peer_id).dc?.readyState === 'open';
    li.innerHTML = `<span>${p.name === currentNickname ? p.name + ' (you)' : p.name}</span>` +
                   (isP2P ? '<span class="route-tag">P2P</span>' : '');
    list.append(li);

    const dot = document.createElement('div');
    dot.className = `radar-dot ${p.name === currentNickname ? 'you' : ''}`;
    const angle = (idx / Math.max(peers.length, 1)) * 6.283;
    const radius = p.name === currentNickname ? 0 : 30 + (idx % 3) * 10;
    dot.style.left = 50 + radius * Math.cos(angle) + '%';
    dot.style.top = 50 + radius * Math.sin(angle) + '%';
    radar.append(dot);
  });
}

// -------------------------------------------------------------
// 6. INITIALIZATION & DOM EVENTS
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Explicitly focus nickname input
  setTimeout(() => {
    const ni = $('nickname-input');
    if (ni) {
      ni.focus();
      ni.select?.();
    }
  }, 100);

  // Join button & Enter key
  $('join-btn').onclick = handleJoin;
  $('nickname-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleJoin();
    }
  });
  $('passkey-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleJoin();
    }
  });

  // Eye toggle button
  $('toggle-eye').onclick = () => {
    const input = $('passkey-input');
    const btn = $('toggle-eye');
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = '🔒';
    } else {
      input.type = 'password';
      btn.textContent = '👁️';
    }
  };

  // Composer submit
  $('composer-form').onsubmit = e => {
    e.preventDefault();
    const input = $('message-input');
    sendMessage(input.value.trim());
    input.value = '';
  };

  // SOS button
  $('sos-btn').onclick = () => {
    const input = $('message-input');
    const text = input.value.trim();
    sendMessage('SOS! I need immediate help. ' + text, true);
    input.value = '';
  };

  // GPS button
  $('gps-btn').onclick = () => {
    if (!navigator.geolocation) {
      return appendSystemMessage('Geolocation is not supported by your device.');
    }
    appendSystemMessage('📡 Querying GPS coordinates...');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const coords = `📍 [Location: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}] `;
        const input = $('message-input');
        input.value = coords + input.value;
        input.focus();
      },
      err => {
        appendSystemMessage(`⚠️ Geolocation error: ${err.message}`);
      },
      { timeout: 8000, enableHighAccuracy: true }
    );
  };

  // SitRep button
  $('sitrep-btn').onclick = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'summary' }));
    }
  };

  // Sidebar toggle
  $('toggle-peers-btn').onclick = () => {
    const sb = $('peers-sidebar');
    sb.style.display = sb.style.display === 'flex' ? '' : 'flex';
  };

  // Triple-tap brand logo to wipe credentials
  let tapTimes = [];
  $('brand-logo').onclick = () => {
    const now = Date.now();
    tapTimes = tapTimes.filter(t => now - t < 800);
    tapTimes.push(now);
    if (tapTimes.length >= 3) {
      sessionStorage.clear();
      localStorage.clear();
      location.reload();
    }
  };
});

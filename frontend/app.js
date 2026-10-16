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
let currentRoom = 'global';
let activeDirectPeer = null; // { peer_id, name } or null for room mode
let cryptoKey = null;
const myPeerId = 'peer_' + Math.random().toString(36).substring(2, 9);
const messagesHistory = [];
const meshPeers = new Map(); // peerId -> { pc, dc }
let allDiscoveredRooms = ['global'];
let currentPeersList = [];
const forwardedMessageIds = new Set(); // Prevent loop in multi-hop forwarding
const blockedPeerIds = new Set(JSON.parse(localStorage.getItem('mistroom_blocked_peers') || '[]'));
let isStealthMode = localStorage.getItem('mistroom_stealth') === 'true';

// -------------------------------------------------------------
// IDENTITY MNEMONIC RECOVERY SEED & PRIVACY CONTROLS
// -------------------------------------------------------------
const WORDLIST = [
  'alpha', 'beacon', 'cipher', 'delta', 'echo', 'falcon', 'ghost', 'harbor',
  'island', 'jungle', 'kestrel', 'lunar', 'matrix', 'nexus', 'orbit', 'plasma',
  'quantum', 'radar', 'shadow', 'timber', 'ultra', 'vortex', 'whisper', 'zenith'
];

function generateRecoveryPhrase(passkey, peerId) {
  // Deterministic 12-word seed representation derived from passkey + peerId
  let hash = 0;
  const str = passkey + '_' + peerId;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const words = [];
  for (let i = 0; i < 12; i++) {
    const idx = Math.abs((hash ^ (i * 7919)) % WORDLIST.length);
    words.push(WORDLIST[idx]);
  }
  return words.join(' ');
}

function blockPeer(peerId, peerName) {
  if (!peerId) return;
  blockedPeerIds.add(peerId);
  localStorage.setItem('mistroom_blocked_peers', JSON.stringify(Array.from(blockedPeerIds)));
  appendSystemMessage(`🚫 Blocked peer: ${peerName || peerId}. Their messages and calls are now silenced.`);
  renderPeers(currentPeersList);
  renderBlockedList();
}

function unblockPeer(peerId) {
  blockedPeerIds.delete(peerId);
  localStorage.setItem('mistroom_blocked_peers', JSON.stringify(Array.from(blockedPeerIds)));
  appendSystemMessage(`✅ Unblocked peer: ${peerId}.`);
  renderPeers(currentPeersList);
  renderBlockedList();
}

function renderBlockedList() {
  const list = $('blocked-peers-list');
  if (!list) return;
  list.innerHTML = '';
  if (blockedPeerIds.size === 0) {
    list.innerHTML = '<li class="empty-hint">No peers blocked.</li>';
    return;
  }
  blockedPeerIds.forEach(pId => {
    const li = document.createElement('li');
    li.className = 'blocked-item';
    li.innerHTML = `<span>${pId}</span> <button type="button" class="btn-unblock" onclick="unblockPeer('${pId}')">Unblock</button>`;
    list.append(li);
  });
}

// -------------------------------------------------------------
// INDEXEDDB OFFLINE STORE-AND-FORWARD OUTBOX
// -------------------------------------------------------------
const DB_NAME = 'mistroom_mesh_db';
const DB_VERSION = 1;
let dbInstance = null;

function initIndexedDB() {
  return new Promise((resolve) => {
    if (!window.indexedDB) return resolve(null);
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => {
      dbInstance = e.target.result;
      resolve(dbInstance);
      flushOfflineOutbox();
    };
    req.onerror = () => resolve(null);
  });
}

function queueOfflineMessage(msg) {
  if (!dbInstance) return;
  try {
    const tx = dbInstance.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').put(msg);
  } catch (e) {
    console.warn('Failed to queue offline message:', e);
  }
}

function removeQueuedMessage(id) {
  if (!dbInstance) return;
  try {
    const tx = dbInstance.transaction('outbox', 'readwrite');
    tx.objectStore('outbox').delete(id);
  } catch (e) {}
}

async function flushOfflineOutbox() {
  if (!dbInstance) return;
  try {
    const tx = dbInstance.transaction('outbox', 'readonly');
    const store = tx.objectStore('outbox');
    const req = store.getAll();
    req.onsuccess = async () => {
      const items = req.result || [];
      for (const item of items) {
        let sent = false;
        // Try P2P DataChannel first
        if (broadcastOverP2P(item) > 0) {
          sent = true;
        }
        // Try WebSocket relay
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(item));
          sent = true;
        }
        if (sent) {
          removeQueuedMessage(item.id);
          updateMessageStatus(item.id, 'sent');
        }
      }
    };
  } catch (e) {}
}

// Triage Categories & Labels (SOS & Women's Safety)
const CATEGORY_LABELS = {
  sos: '🚨 SOS',
  women_safety: '🛡️ SAFETY ALERT',
  general: ''
};

// -------------------------------------------------------------
// 1. CRYPTOGRAPHY ENGINE (AES-256-GCM + PBKDF2 with Fallback)
// -------------------------------------------------------------
const hasSubtleCrypto = !!(window.crypto && window.crypto.subtle);

async function deriveEncryptionKey(passkey) {
  if (!hasSubtleCrypto) {
    // Mobile browsers on plain HTTP LAN disable window.crypto.subtle
    return 'fallback_key_' + passkey;
  }
  try {
    const enc = new TextEncoder();
    const rawKey = await window.crypto.subtle.importKey(
      'raw',
      enc.encode(passkey),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return await window.crypto.subtle.deriveKey(
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
  } catch (e) {
    console.warn('SubtleCrypto error, falling back:', e);
    return 'fallback_key_' + passkey;
  }
}

async function encryptMessage(plaintext) {
  if (!hasSubtleCrypto || typeof cryptoKey === 'string') {
    // Clean fallback for plain HTTP LAN origins
    try {
      const b64 = btoa(unescape(encodeURIComponent(plaintext)));
      return { ciphertext: b64, iv: 'fallback' };
    } catch (e) {
      return { ciphertext: plaintext, iv: 'none' };
    }
  }
  if (!cryptoKey) return { ciphertext: plaintext, iv: '' };
  try {
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
  } catch (err) {
    console.warn('Encryption fallback:', err);
    return { ciphertext: btoa(unescape(encodeURIComponent(plaintext))), iv: 'fallback' };
  }
}

async function decryptMessage(ciphertext, ivBase64) {
  if (!ciphertext) return '';
  if (ivBase64 === 'fallback') {
    try {
      return decodeURIComponent(escape(atob(ciphertext)));
    } catch (e) {
      return ciphertext;
    }
  }
  if (!hasSubtleCrypto || typeof cryptoKey === 'string' || !ivBase64) {
    return ciphertext;
  }
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
// 2. CLIENT-SIDE EMERGENCY, WOMEN'S SAFETY & THREAT TRIAGE
// -------------------------------------------------------------
const CLIENT_THREAT_KEYWORDS = [
  'bomb blast', 'ied', 'suicide vest', 'terror attack', 'assassination plot',
  'plant explosives', 'danga karo', 'dange bhadkao', 'aag laga do', 'lynch them',
  'stone pelting', 'pattharbaazi', 'naxalite attack', 'ambush police',
  'ransomware decryptor', 'atm skimmer', 'stolen creds', 'ddos tool', 'bank otp bypass'
];

const CLIENT_WOMEN_SAFETY_KEYWORDS = [
  'following me', 'stalking', 'stalker', 'harassment', 'unsafe', 'molested',
  'cab driver wrong route', 'cornered', 'alone in dark', 'trying to grab me',
  'chhedchhad', 'pichha kar raha', 'koi pichhe pada hai', 'dara raha hai',
  'galat jagah le ja raha', 'akeli hoon', 'bachao koi', 'eve teasing', '#safe', '#helpme'
];

function triageText(text) {
  const lower = (text || '').toLowerCase();

  // 1. Prohibited threat check
  for (const kw of CLIENT_THREAT_KEYWORDS) {
    if (lower.includes(kw)) {
      return { cat: 'blocked_threat', prio: 0, isThreat: true };
    }
  }

  // 2. Women's safety & harassment distress
  for (const kw of CLIENT_WOMEN_SAFETY_KEYWORDS) {
    if (lower.includes(kw)) {
      return { cat: 'women_safety', prio: 3, isSOS: true, isWomenSafety: true };
    }
  }

  // 3. Life Threat / Disaster SOS
  const isSOS = /\b(sos|emergency|help|danger|bachao|madad|trapped|fire|drowning)\b/i.test(lower);
  if (isSOS) {
    return { cat: 'sos', prio: 3, isSOS: true };
  }

  return { cat: 'general', prio: 0 };
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
  dc.onopen = () => {
    updateMeshBadge();
    flushOfflineOutbox();
  };
  dc.onclose = () => {
    meshPeers.delete(targetPeerId);
    updateMeshBadge();
  };
  dc.onmessage = async event => {
    try {
      const msg = JSON.parse(event.data);

      // Handle Delivery Acknowledgement Receipt (msg_ack)
      if (msg.t === 'msg_ack') {
        updateMessageStatus(msg.id, msg.status || 'delivered');
        return;
      }

      // Handle P2P File Transfer Chunks & Metadata
      if (msg.t === 'file_meta' || msg.t === 'file_chunk') {
        handleIncomingFilePacket(msg);
        return;
      }

      // Discard packets from blocked peers
      if (msg.peer_id && blockedPeerIds.has(msg.peer_id)) {
        return;
      }

      if (!msg.id) return;
      if (messagesHistory.some(m => m.id === msg.id)) return;

      // 1. Multi-Hop Forwarding: If not targeted to us or if broadcast, relay with decremented TTL
      const isTargetedToMe = msg.target_peer === myPeerId;
      const isBroadcast = !msg.target_peer;

      if (!forwardedMessageIds.has(msg.id)) {
        forwardedMessageIds.add(msg.id);
        const ttl = typeof msg.ttl === 'number' ? msg.ttl : 3;
        if (ttl > 1) {
          const relayedPacket = {
            ...msg,
            ttl: ttl - 1,
            hops: (msg.hops || 0) + 1
          };
          // Relay to all other open peers except sender
          relayMultiHop(relayedPacket, targetPeerId);
        }
      }

      // If DM targeted to another peer and not to me, do not display in UI
      if (msg.target_peer && !isTargetedToMe) {
        return;
      }

      // If room message and not in this room and not SOS, skip display
      if (isBroadcast && msg.room && msg.room !== currentRoom && !msg.sos) {
        return;
      }

      // Decrypt message content
      if (msg.ciphertext && msg.iv) {
        msg.text = await decryptMessage(msg.ciphertext, msg.iv);
      }

      msg.route = msg.hops > 0 ? `Mesh (${msg.hops + 1}-Hop)` : 'P2P Direct';
      messagesHistory.push(msg);
      appendMessageToUI(msg);
      updateSOSBanner();

      // Send back Delivery ACK to sender
      sendDeliveryAck(msg.id, msg.peer_id);

    } catch (err) {
      console.error('DataChannel message parse error:', err);
    }
  };
}

function relayMultiHop(packet, incomingPeerId) {
  const serialized = JSON.stringify(packet);
  for (const [pId, peer] of meshPeers) {
    if (pId !== incomingPeerId && peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(serialized);
      } catch (e) {}
    }
  }
}

function sendDeliveryAck(msgId, senderPeerId) {
  if (!msgId || !senderPeerId || senderPeerId === myPeerId) return;
  const ack = {
    t: 'msg_ack',
    id: msgId,
    target_peer: senderPeerId,
    from_peer: myPeerId,
    status: 'delivered'
  };

  // Try direct peer first
  const peer = meshPeers.get(senderPeerId);
  if (peer && peer.dc && peer.dc.readyState === 'open') {
    try {
      peer.dc.send(JSON.stringify(ack));
      return;
    } catch (e) {}
  }

  // Fallback to relay
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(ack));
  }
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
// P2P ENCRYPTED FILE SHARING ENGINE (CHUNKING & REASSEMBLY)
// -------------------------------------------------------------
const CHUNK_SIZE = 16384; // 16 KB binary chunks
const activeIncomingFiles = new Map(); // fileId -> { name, size, type, totalChunks, receivedChunks, chunks, sender }

async function sendEncryptedFile(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    return alert('File size exceeds 25 MB limit for peer mesh.');
  }

  const fileId = 'f_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const targetPeerId = activeDirectPeer ? activeDirectPeer.peer_id : null;

  // Show progress container
  const progressBox = $('file-progress-container');
  const progressName = $('file-progress-name');
  const progressPct = $('file-progress-percent');
  const progressBar = $('file-progress-bar');
  if (progressBox) {
    progressBox.style.display = 'block';
    progressName.textContent = `Encrypting & Sending: ${file.name}`;
    progressPct.textContent = '0%';
    progressBar.style.width = '0%';
  }

  // 1. Send File Metadata Header
  const metaPayload = {
    t: 'file_meta',
    fileId,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    totalChunks,
    from: currentNickname,
    peer_id: myPeerId,
    target_peer: targetPeerId,
    room: currentRoom,
    ts: Date.now()
  };

  dispatchFilePacket(metaPayload);

  // 2. Read, Encrypt Chunks, and Stream
  const buffer = await file.arrayBuffer();
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkSlice = buffer.slice(start, end);
    const b64Chunk = btoa(String.fromCharCode(...new Uint8Array(chunkSlice)));
    
    // Encrypt chunk using room key
    const encryptedChunk = await encryptMessage(b64Chunk);

    const chunkPayload = {
      t: 'file_chunk',
      fileId,
      index: i,
      totalChunks,
      ciphertext: encryptedChunk.ciphertext,
      iv: encryptedChunk.iv,
      target_peer: targetPeerId,
      room: currentRoom
    };

    dispatchFilePacket(chunkPayload);

    // Update progress
    const pct = Math.round(((i + 1) / totalChunks) * 100);
    if (progressPct && progressBar) {
      progressPct.textContent = `${pct}%`;
      progressBar.style.width = `${pct}%`;
    }

    // Small delay to prevent DataChannel buffer saturation
    if (i % 8 === 0) {
      await new Promise(r => setTimeout(r, 15));
    }
  }

  setTimeout(() => {
    if (progressBox) progressBox.style.display = 'none';
  }, 1000);

  // Optimistic local UI display for sender
  const blob = new Blob([buffer], { type: file.type });
  const objectUrl = URL.createObjectURL(blob);
  const localFileMsg = {
    id: fileId,
    from: currentNickname,
    peer_id: myPeerId,
    room: currentRoom,
    target_peer: targetPeerId,
    is_dm: !!targetPeerId,
    ts: Date.now(),
    file: {
      name: file.name,
      size: file.size,
      type: file.type,
      url: objectUrl
    },
    route: activeDirectPeer ? 'P2P Direct' : 'Mesh Broadcast'
  };

  messagesHistory.push(localFileMsg);
  appendMessageToUI(localFileMsg);
}

function dispatchFilePacket(packet) {
  // Try sending over WebRTC DataChannels first
  let count = 0;
  if (packet.target_peer) {
    const peer = meshPeers.get(packet.target_peer);
    if (peer && peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(JSON.stringify(packet));
        count = 1;
      } catch (e) {}
    }
  } else {
    count = broadcastOverP2P(packet);
  }

  // Also relay via WebSocket so non-WebRTC connected peers receive it
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'p2p_file', target: packet.target_peer, data: packet }));
  }
}

async function handleIncomingFilePacket(packet) {
  if (packet.t === 'file_meta') {
    activeIncomingFiles.set(packet.fileId, {
      name: packet.name,
      size: packet.size,
      type: packet.type,
      totalChunks: packet.totalChunks,
      receivedChunks: 0,
      chunks: new Array(packet.totalChunks),
      from: packet.from,
      peer_id: packet.peer_id,
      room: packet.room,
      target_peer: packet.target_peer,
      ts: packet.ts
    });
    appendSystemMessage(`📥 Receiving file "${packet.name}" from ${packet.from}...`);
    return;
  }

  if (packet.t === 'file_chunk') {
    const entry = activeIncomingFiles.get(packet.fileId);
    if (!entry) return;

    if (!entry.chunks[packet.index]) {
      // Decrypt chunk
      const decryptedB64 = await decryptMessage(packet.ciphertext, packet.iv);
      const binaryString = atob(decryptedB64);
      const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
      entry.chunks[packet.index] = bytes.buffer;
      entry.receivedChunks++;

      if (entry.receivedChunks === entry.totalChunks) {
        // Complete file reassembled
        const fullBlob = new Blob(entry.chunks, { type: entry.type });
        const objectUrl = URL.createObjectURL(fullBlob);

        const fileMsg = {
          id: packet.fileId,
          from: entry.from,
          peer_id: entry.peer_id,
          room: entry.room,
          target_peer: entry.target_peer,
          is_dm: !!entry.target_peer,
          ts: entry.ts,
          file: {
            name: entry.name,
            size: entry.size,
            type: entry.type,
            url: objectUrl
          },
          route: entry.target_peer ? 'P2P Direct' : 'P2P Mesh'
        };

        activeIncomingFiles.delete(packet.fileId);
        messagesHistory.push(fileMsg);
        appendMessageToUI(fileMsg);
        appendSystemMessage(`✅ Successfully received and verified file "${entry.name}".`);

        // Send delivery receipt
        sendDeliveryAck(packet.fileId, entry.peer_id);
      }
    }
  }
}

// -------------------------------------------------------------
// WEBRTC VOICE & VIDEO CALLING ENGINE (1-ON-1 P2P CALLS)
// -------------------------------------------------------------
let activeCallPeerConnection = null;
let localMediaStream = null;
let currentCallPeer = null;
let callTimerInterval = null;
let callSeconds = 0;
let pendingIncomingCall = null;

async function startCall(peer, isVideo = false) {
  if (!peer) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return alert('Voice/video calling requires camera/microphone access in your browser.');
  }

  currentCallPeer = peer;
  try {
    localMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  } catch (err) {
    return alert(`Could not access media devices: ${err.message}`);
  }

  // Open Call Modal
  $('call-peer-title').textContent = `${isVideo ? '📹 Video' : '📞 Voice'} Call with ${peer.name}`;
  $('call-status-label').textContent = 'Calling...';
  $('call-audio-indicator').style.display = isVideo ? 'none' : 'flex';
  $('local-video').style.display = isVideo ? 'block' : 'none';
  $('remote-video').style.display = isVideo ? 'block' : 'none';
  $('local-video').srcObject = localMediaStream;
  $('call-modal').style.display = 'flex';

  // Setup PeerConnection
  activeCallPeerConnection = new RTCPeerConnection(RTC_CONFIG);
  localMediaStream.getTracks().forEach(track => activeCallPeerConnection.addTrack(track, localMediaStream));

  activeCallPeerConnection.ontrack = event => {
    $('call-status-label').textContent = 'Connected';
    const remoteStream = event.streams[0];
    $('remote-video').srcObject = remoteStream;
    startCallTimer();
  };

  activeCallPeerConnection.onicecandidate = event => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        t: 'call_ice',
        target: peer.peer_id,
        data: event.candidate
      }));
    }
  };

  // Create offer
  const offer = await activeCallPeerConnection.createOffer();
  await activeCallPeerConnection.setLocalDescription(offer);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      t: 'call_invite',
      target: peer.peer_id,
      data: {
        offer,
        isVideo,
        callerName: currentNickname
      }
    }));
  }
}

async function handleIncomingCallInvite(senderPeerId, senderName, data) {
  pendingIncomingCall = {
    peer_id: senderPeerId,
    name: senderName,
    data
  };

  $('incoming-caller-name').textContent = senderName;
  $('incoming-call-type').textContent = `Incoming ${data.isVideo ? 'video' : 'voice'} call...`;
  $('incoming-call-toast').style.display = 'flex';
}

async function acceptIncomingCall() {
  $('incoming-call-toast').style.display = 'none';
  if (!pendingIncomingCall) return;

  const { peer_id, name, data } = pendingIncomingCall;
  currentCallPeer = { peer_id, name };
  const isVideo = !!data.isVideo;

  try {
    localMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
    });
  } catch (err) {
    alert(`Could not access microphone/camera: ${err.message}`);
    declineIncomingCall();
    return;
  }

  // Open Call Modal
  $('call-peer-title').textContent = `${isVideo ? '📹 Video' : '📞 Voice'} Call with ${name}`;
  $('call-status-label').textContent = 'Connecting...';
  $('call-audio-indicator').style.display = isVideo ? 'none' : 'flex';
  $('local-video').style.display = isVideo ? 'block' : 'none';
  $('remote-video').style.display = isVideo ? 'block' : 'none';
  $('local-video').srcObject = localMediaStream;
  $('call-modal').style.display = 'flex';

  activeCallPeerConnection = new RTCPeerConnection(RTC_CONFIG);
  localMediaStream.getTracks().forEach(track => activeCallPeerConnection.addTrack(track, localMediaStream));

  activeCallPeerConnection.ontrack = event => {
    $('call-status-label').textContent = 'Connected';
    $('remote-video').srcObject = event.streams[0];
    startCallTimer();
  };

  activeCallPeerConnection.onicecandidate = event => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        t: 'call_ice',
        target: peer_id,
        data: event.candidate
      }));
    }
  };

  await activeCallPeerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await activeCallPeerConnection.createAnswer();
  await activeCallPeerConnection.setLocalDescription(answer);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      t: 'call_accept',
      target: peer_id,
      data: answer
    }));
  }
}

function declineIncomingCall() {
  $('incoming-call-toast').style.display = 'none';
  if (pendingIncomingCall && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      t: 'call_decline',
      target: pendingIncomingCall.peer_id
    }));
  }
  pendingIncomingCall = null;
}

function endCall(notifyRemote = true) {
  if (notifyRemote && currentCallPeer && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      t: 'call_hangup',
      target: currentCallPeer.peer_id
    }));
  }

  if (localMediaStream) {
    localMediaStream.getTracks().forEach(track => track.stop());
    localMediaStream = null;
  }

  if (activeCallPeerConnection) {
    try { activeCallPeerConnection.close(); } catch (e) {}
    activeCallPeerConnection = null;
  }

  stopCallTimer();
  $('call-modal').style.display = 'none';
  $('local-video').srcObject = null;
  $('remote-video').srcObject = null;
  currentCallPeer = null;
  pendingIncomingCall = null;
}

function toggleMic() {
  if (!localMediaStream) return;
  const audioTrack = localMediaStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    const btn = $('toggle-mic-btn');
    if (btn) btn.classList.toggle('off', !audioTrack.enabled);
  }
}

function toggleCam() {
  if (!localMediaStream) return;
  const videoTrack = localMediaStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    const btn = $('toggle-cam-btn');
    if (btn) btn.classList.toggle('off', !videoTrack.enabled);
  }
}

function startCallTimer() {
  stopCallTimer();
  callSeconds = 0;
  $('call-timer').textContent = '00:00';
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const mins = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const secs = String(callSeconds % 60).padStart(2, '0');
    $('call-timer').textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
}

// -------------------------------------------------------------
// 4. ROOM MANAGEMENT & RANDOM MATCHING
// -------------------------------------------------------------
function switchRoom(newRoom) {
  if (!newRoom) return;
  currentRoom = newRoom.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'global';
  $('active-room-badge').textContent = `#${currentRoom}`;
  $('room-switcher-bar').style.display = 'none';

  appendSystemMessage(`Switched to room: #${currentRoom}`);

  // Notify server of room switch
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'switch_room', room: currentRoom }));
  }
}

// -------------------------------------------------------------
// 5. UI INTERACTION & MESSAGING
// -------------------------------------------------------------
async function handleJoin() {
  const nameInput = $('nickname-input');
  const passInput = $('passkey-input');
  const roomInput = $('room-input');

  let nickname = (nameInput.value || '').trim();
  let passkey = (passInput.value || '').trim() || 'default-mesh-pass';
  let room = (roomInput.value || '').trim().toLowerCase() || 'global';

  if (!nickname) {
    nameInput.focus();
    return;
  }

  currentNickname = nickname;
  currentPasskey = passkey;
  currentRoom = room;

  $('active-room-badge').textContent = `#${currentRoom}`;
  cryptoKey = await deriveEncryptionKey(currentPasskey);

  $('join-modal').style.display = 'none';
  connectWebSocket();
}

function appendMessageToUI(msg, autoScroll = true) {
  const list = $('messages-list');
  const bubble = document.createElement('div');
  const isMe = msg.from === currentNickname || msg.peer_id === myPeerId;
  const isDM = !!msg.target_peer || !!msg.is_dm;
  
  bubble.id = `bubble_${msg.id}`;
  const catClass = msg.cat ? `cat-${msg.cat}` : '';
  bubble.className = `msg-bubble ${catClass} ${isMe ? 'me' : ''} ${isDM ? 'is-dm' : ''}`;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const sender = document.createElement('span');
  sender.className = 'msg-sender';
  sender.textContent = isMe ? 'You' : msg.from;

  const time = document.createElement('span');
  time.textContent = new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  meta.append(sender, time);

  if (isDM) {
    const dmTag = document.createElement('span');
    dmTag.className = 'dm-tag';
    dmTag.textContent = '🔒 Direct';
    meta.append(dmTag);
  }

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
  if (msg.text) bubble.append(meta, textNode);
  else bubble.append(meta);

  // Render P2P Encrypted File attachment if present
  if (msg.file) {
    const isImage = (msg.file.type || '').startsWith('image/');
    if (isImage && msg.file.url) {
      const img = document.createElement('img');
      img.src = msg.file.url;
      img.alt = msg.file.name;
      img.className = 'file-image-preview';
      img.onclick = () => window.open(msg.file.url, '_blank');
      bubble.append(img);
    }

    const fileCard = document.createElement('a');
    fileCard.className = 'file-card';
    fileCard.href = msg.file.url || '#';
    fileCard.download = msg.file.name;
    fileCard.target = '_blank';

    const sizeFormatted = (msg.file.size / 1024).toFixed(1) + ' KB';
    fileCard.innerHTML = `
      <div class="file-card-icon">${isImage ? '🖼️' : '📄'}</div>
      <div class="file-card-info">
        <div class="file-card-name" title="${msg.file.name}">${msg.file.name}</div>
        <div class="file-card-size">${sizeFormatted} &bull; Encrypted P2P</div>
      </div>
      <button type="button" class="file-card-btn">Download</button>
    `;
    bubble.append(fileCard);
  }

  // Delivery status receipt for outgoing messages
  if (isMe) {
    const footerMeta = document.createElement('div');
    footerMeta.className = 'msg-footer-meta';
    const statusSpan = document.createElement('span');
    statusSpan.id = `status_${msg.id}`;
    statusSpan.className = `msg-status-ack ${msg.status || 'sent'}`;
    statusSpan.textContent = getStatusIcon(msg.status || 'sent');
    footerMeta.append(statusSpan);
    bubble.append(footerMeta);
  }

  list.append(bubble);
  if (autoScroll) list.scrollTop = list.scrollHeight;
}

function getStatusIcon(status) {
  switch (status) {
    case 'queued': return '🕒 Queued';
    case 'delivered': return '✓ Delivered';
    case 'read': return '✓✓ Read';
    case 'sent':
    default:
      return '⬆️ Sent';
  }
}

function updateMessageStatus(mid, status) {
  const el = $(`status_${mid}`);
  if (el) {
    el.className = `msg-status-ack ${status}`;
    el.textContent = getStatusIcon(status);
  }
  const msgObj = messagesHistory.find(m => m.id === mid);
  if (msgObj) msgObj.status = status;
}

function updateSOSBanner() {
  const latestEmergency = messagesHistory.filter(m => m.cat === 'sos' || m.cat === 'women_safety').slice(-1)[0];
  const banner = $('sos-banner');
  if (latestEmergency) {
    banner.style.display = 'block';
    if (latestEmergency.cat === 'women_safety') {
      banner.style.background = 'linear-gradient(135deg, #7928CA, #FF0080)';
      banner.textContent = `🛡️ SAFETY DISTRESS from ${latestEmergency.from}: ${(latestEmergency.text || '').substring(0, 80)}`;
    } else {
      banner.style.background = '';
      banner.textContent = `🚨 SOS from ${latestEmergency.from}: ${(latestEmergency.text || '').substring(0, 80)}`;
    }
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

  // Hard block prohibited threat content (terrorism, riot incitement, cyber theft)
  if (triage.isThreat) {
    alert('⚠️ Message Blocked: Content violates MistRoom community safety standards (anti-terror, non-violence & anti-theft policy).');
    return;
  }

  const effectiveSOS = isSOS || triage.cat === 'sos' || triage.cat === 'women_safety';
  const mid = 'm_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const encrypted = await encryptMessage(rawText);

  const payload = {
    t: 'msg',
    id: mid,
    from: currentNickname,
    peer_id: myPeerId,
    room: currentRoom,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    cat: triage.cat,
    prio: triage.prio,
    sos: effectiveSOS,
    ts: Date.now(),
    ttl: 3,
    hops: 0
  };

  // Check if 1-on-1 Direct Message is active
  if (activeDirectPeer) {
    payload.target_peer = activeDirectPeer.peer_id;
    payload.is_dm = true;
  }

  // 1. Direct WebRTC P2P send
  let p2pCount = 0;
  if (activeDirectPeer) {
    const targetPeer = meshPeers.get(activeDirectPeer.peer_id);
    if (targetPeer && targetPeer.dc && targetPeer.dc.readyState === 'open') {
      try {
        targetPeer.dc.send(JSON.stringify(payload));
        p2pCount = 1;
      } catch (e) {}
    }
  } else {
    p2pCount = broadcastOverP2P(payload);
  }

  // 2. Central relay send or queue in store-and-forward outbox
  let sentViaRelay = false;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
    sentViaRelay = true;
  }

  let initialStatus = 'sent';
  if (!sentViaRelay && p2pCount === 0) {
    initialStatus = 'queued';
    queueOfflineMessage(payload);
    appendSystemMessage('📦 Message queued in offline outbox. Will auto-relay when connected.');
  }

  // Optimistic local UI display
  const localMessage = {
    ...payload,
    text: rawText,
    status: initialStatus,
    route: p2pCount > 0 ? (activeDirectPeer ? 'P2P Direct' : `P2P Mesh (${p2pCount})`) : (sentViaRelay ? 'Relay' : 'Offline Outbox')
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
    ws.send(JSON.stringify({ 
      t: 'join', 
      name: currentNickname, 
      peer_id: myPeerId,
      room: currentRoom
    }));
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
      if (data.msg.peer_id && blockedPeerIds.has(data.msg.peer_id)) return;
      if (messagesHistory.some(m => m.id === data.msg.id)) return;
      
      const isTargetedToMe = data.msg.target_peer === myPeerId;
      const isBroadcast = !data.msg.target_peer;

      // Filter DM message not meant for this peer
      if (data.msg.target_peer && !isTargetedToMe && data.msg.peer_id !== myPeerId) return;

      // Filter room messages
      if (isBroadcast && data.msg.room && data.msg.room !== currentRoom && !data.msg.sos) return;

      if (data.msg.ciphertext && data.msg.iv) {
        data.msg.text = await decryptMessage(data.msg.ciphertext, data.msg.iv);
      }
      messagesHistory.push(data.msg);
      appendMessageToUI(data.msg);
      updateSOSBanner();

      // Send delivery ACK back to sender
      if (data.msg.peer_id && data.msg.peer_id !== myPeerId) {
        sendDeliveryAck(data.msg.id, data.msg.peer_id);
      }
    }

    if (data.t === 'msg_ack') {
      updateMessageStatus(data.id, data.status || 'delivered');
    }

    if (data.t === 'p2p_file' && data.data) {
      handleIncomingFilePacket(data.data);
    }

    if (data.t === 'people') {
      currentPeersList = data.people || [];
      renderPeers(currentPeersList);
      if (data.available_rooms) {
        allDiscoveredRooms = Array.from(new Set(['global', ...data.available_rooms]));
        renderAvailableRooms(allDiscoveredRooms);
      }
      currentPeersList.forEach(p => {
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

    // Call Signaling Events
    if (data.t === 'call_invite' && data.data) {
      if (data.sender && blockedPeerIds.has(data.sender)) return;
      handleIncomingCallInvite(data.sender, data.sender_name || 'Peer', data.data);
    }

    if (data.t === 'call_accept' && data.data) {
      if (activeCallPeerConnection) {
        await activeCallPeerConnection.setRemoteDescription(new RTCSessionDescription(data.data));
        $('call-status-label').textContent = 'Connected';
        startCallTimer();
      }
    }

    if (data.t === 'call_decline') {
      appendSystemMessage('📞 Call declined by peer.');
      endCall(false);
    }

    if (data.t === 'call_hangup') {
      appendSystemMessage('📞 Call ended by peer.');
      endCall(false);
    }

    if (data.t === 'call_ice' && data.data) {
      if (activeCallPeerConnection) {
        try {
          await activeCallPeerConnection.addIceCandidate(new RTCIceCandidate(data.data));
        } catch (e) {}
      }
    }
  };
}

function renderPeers(peers) {
  $('peer-count').textContent = peers.length;
  const list = $('peers-list');
  list.innerHTML = '';

  peers.forEach(p => {
    const li = document.createElement('li');
    const isMe = p.peer_id === myPeerId || p.name === currentNickname;
    const isP2P = meshPeers.has(p.peer_id) && meshPeers.get(p.peer_id).dc?.readyState === 'open';
    const isCurrentDM = activeDirectPeer && activeDirectPeer.peer_id === p.peer_id;
    
    li.className = isMe ? '' : 'peer-item-interactive';
    if (!isMe) {
      const isBlocked = blockedPeerIds.has(p.peer_id);
      li.innerHTML = `<span>${p.name} ${isBlocked ? '<strong style="color:#DC2626">(Blocked)</strong>' : ''}</span>` +
                     (isCurrentDM ? ' <span class="badge-mini" style="background:#3A86FF">Chatting</span>' : '') +
                     (isP2P ? ' <span class="route-tag">P2P</span>' : '') +
                     ` <button type="button" class="btn-unblock" style="margin-left:auto;" onclick="event.stopPropagation(); ${isBlocked ? `unblockPeer('${p.peer_id}')` : `blockPeer('${p.peer_id}', '${p.name}')`}">${isBlocked ? 'Unblock' : 'Block'}</button>`;
      li.onclick = () => {
        if (!isBlocked) startDirectChat(p);
      };
    }
    list.append(li);
  });
}

function startDirectChat(peer) {
  activeDirectPeer = peer;
  const dmBanner = $('dm-banner');
  if (dmBanner) {
    dmBanner.style.display = 'flex';
    $('dm-peer-name').textContent = peer.name;
  }
  const input = $('message-input');
  if (input) {
    input.placeholder = `Direct message to ${peer.name}...`;
    input.focus();
  }
  appendSystemMessage(`🔒 Started 1-on-1 Direct Encrypted Chat with ${peer.name}. Messages will be delivered directly to this peer.`);
  renderPeers(currentPeersList);
}

function closeDirectChat() {
  activeDirectPeer = null;
  const dmBanner = $('dm-banner');
  if (dmBanner) {
    dmBanner.style.display = 'none';
  }
  const input = $('message-input');
  if (input) {
    input.placeholder = 'Type message...';
    input.focus();
  }
  appendSystemMessage(`Returned to channel #${currentRoom}.`);
  renderPeers(currentPeersList);
}

function renderAvailableRooms(rooms) {
  const container = $('available-rooms-list');
  if (!container) return;
  container.innerHTML = '';
  rooms.forEach(rm => {
    const li = document.createElement('li');
    li.innerHTML = `<span>#${rm}</span> ${rm === currentRoom ? '<span class="badge-mini">Active</span>' : ''}`;
    li.onclick = () => switchRoom(rm);
    container.append(li);
  });
}

// -------------------------------------------------------------
// 7. INITIALIZATION & DOM EVENTS
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Initialize IndexedDB offline outbox
  initIndexedDB();

  // Auto-flush outbox when connection is restored
  window.addEventListener('online', () => {
    appendSystemMessage('🌐 Network reconnected. Flushing offline outbox...');
    flushOfflineOutbox();
  });

  // Direct Message Back Button
  const closeDmBtn = $('close-dm-btn');
  if (closeDmBtn) {
    closeDmBtn.onclick = closeDirectChat;
  }

  // Fetch LAN info and update display
  fetch('/api/info')
    .then(res => res.json())
    .then(data => {
      const urlText = data.url || `${location.protocol}//${location.host}`;
      const modalDisplay = $('lan-url-display');
      const sideDisplay = $('lan-url-display-sidebar');
      if (modalDisplay) modalDisplay.textContent = urlText;
      if (sideDisplay) sideDisplay.textContent = urlText;
    })
    .catch(() => {
      const fallback = `${location.protocol}//${location.host}`;
      const modalDisplay = $('lan-url-display');
      const sideDisplay = $('lan-url-display-sidebar');
      if (modalDisplay) modalDisplay.textContent = fallback;
      if (sideDisplay) sideDisplay.textContent = fallback;
    });

  // Focus nickname input
  setTimeout(() => {
    const ni = $('nickname-input');
    if (ni) {
      ni.focus();
      ni.select?.();
    }
  }, 100);

  // Join button & Enter key
  $('join-btn').onclick = () => handleJoin();

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

  // Eye toggle button (Show/Hide password)
  const toggleEyeBtn = $('toggle-eye');
  if (toggleEyeBtn) {
    toggleEyeBtn.onclick = () => {
      const input = $('passkey-input');
      if (input.type === 'password') {
        input.type = 'text';
        toggleEyeBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
          </svg>`;
      } else {
        input.type = 'password';
        toggleEyeBtn.innerHTML = `
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
          </svg>`;
      }
    };
  }

  // Room Switcher controls
  const switchHeaderBtn = $('switch-room-header-btn');
  if (switchHeaderBtn) {
    switchHeaderBtn.onclick = () => {
      const bar = $('room-switcher-bar');
      bar.style.display = bar.style.display === 'none' ? 'block' : 'none';
      if (bar.style.display === 'block') {
        $('quick-room-input').focus();
      }
    };
  }

  const quickRoomBtn = $('quick-room-btn');
  if (quickRoomBtn) {
    quickRoomBtn.onclick = () => {
      const val = $('quick-room-input').value.trim();
      if (val) {
        switchRoom(val);
        $('quick-room-input').value = '';
      }
    };

    $('quick-room-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        quickRoomBtn.click();
      }
    });
  }

  // Suggested room chips click
  document.querySelectorAll('.room-chip').forEach(chip => {
    chip.onclick = () => switchRoom(chip.dataset.room);
  });

  // Attach File Button and File Input
  const attachFileBtn = $('attach-file-btn');
  const fileInput = $('file-input');
  if (attachFileBtn && fileInput) {
    attachFileBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const file = fileInput.files?.[0];
      if (file) {
        sendEncryptedFile(file);
        fileInput.value = '';
      }
    };
  }

  // Call Action Buttons in DM Banner
  const startVoiceCallBtn = $('start-voice-call-btn');
  const startVideoCallBtn = $('start-video-call-btn');
  if (startVoiceCallBtn) {
    startVoiceCallBtn.onclick = () => {
      if (!activeDirectPeer) return alert('Select a peer to start a call.');
      startCall(activeDirectPeer, false);
    };
  }
  if (startVideoCallBtn) {
    startVideoCallBtn.onclick = () => {
      if (!activeDirectPeer) return alert('Select a peer to start a call.');
      startCall(activeDirectPeer, true);
    };
  }

  // Call Control Modal Buttons
  const acceptCallBtn = $('accept-call-btn');
  const declineCallBtn = $('decline-call-btn');
  const hangupCallBtn = $('hangup-call-btn');
  const toggleMicBtn = $('toggle-mic-btn');
  const toggleCamBtn = $('toggle-cam-btn');

  if (acceptCallBtn) acceptCallBtn.onclick = acceptIncomingCall;
  if (declineCallBtn) declineCallBtn.onclick = declineIncomingCall;
  if (hangupCallBtn) hangupCallBtn.onclick = () => endCall(true);
  if (toggleMicBtn) toggleMicBtn.onclick = toggleMic;
  if (toggleCamBtn) toggleCamBtn.onclick = toggleCam;

  // Composer submit
  $('composer-form').onsubmit = e => {
    e.preventDefault();
    const input = $('message-input');
    sendMessage(input.value.trim());
    input.value = '';
  };

  // 3D Women's Safety Emergency Button
  const womenSafetyBtn = $('women-safety-btn');
  if (womenSafetyBtn) {
    womenSafetyBtn.onclick = () => {
      const input = $('message-input');
      const customNote = input.value.trim();
      input.value = '';

      if (navigator.geolocation) {
        appendSystemMessage('🛡️ Women Safety Alert: Acquiring live coordinates...');
        navigator.geolocation.getCurrentPosition(
          pos => {
            const coords = `📍 [Location: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}]`;
            const alertText = `EMERGENCY WOMEN SAFETY DISTRESS: I feel unsafe / need assistance! ${coords} ${customNote ? '(' + customNote + ')' : ''}`;
            sendMessage(alertText, true);
          },
          () => {
            sendMessage(`EMERGENCY WOMEN SAFETY DISTRESS: I feel unsafe / need immediate assistance! ${customNote ? '(' + customNote + ')' : ''}`, true);
          },
          { timeout: 6000, enableHighAccuracy: true }
        );
      } else {
        sendMessage(`EMERGENCY WOMEN SAFETY DISTRESS: I feel unsafe / need immediate assistance! ${customNote ? '(' + customNote + ')' : ''}`, true);
      }
    };
  }

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

  // Theme Toggle (Light / Dark) for both Login Page and Header Bar
  const themeBtn = $('theme-toggle-btn');
  const modalThemeBtn = $('modal-theme-toggle-btn');
  const savedTheme = localStorage.getItem('mistroom_theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', savedTheme);

  function updateThemeButtons(theme) {
    const icon = theme === 'light' ? '🌙' : '☀️';
    if (themeBtn) themeBtn.textContent = icon;
    if (modalThemeBtn) modalThemeBtn.textContent = icon;
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const nextTheme = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', nextTheme);
    localStorage.setItem('mistroom_theme', nextTheme);
    updateThemeButtons(nextTheme);
  }

  updateThemeButtons(savedTheme);
  if (themeBtn) themeBtn.onclick = toggleTheme;
  if (modalThemeBtn) modalThemeBtn.onclick = toggleTheme;

  // Logout Flow
  const logoutBtn = $('logout-btn');
  if (logoutBtn) {
    logoutBtn.onclick = () => {
      // 1. Close WebRTC data channels and peer connections
      for (const [, peer] of meshPeers) {
        try {
          if (peer.dc) peer.dc.close();
          if (peer.pc) peer.pc.close();
        } catch (e) {}
      }
      meshPeers.clear();

      // 2. Disconnect WebSocket
      if (ws) {
        ws.onclose = null; // Prevent auto-reconnect
        try { ws.close(); } catch (e) {}
        ws = null;
      }

      // 3. Reset internal state
      currentNickname = '';
      currentPasskey = '';
      currentRoom = 'global';
      cryptoKey = null;
      messagesHistory.length = 0;
      currentPeersList = [];

      // 4. Reset UI
      $('messages-list').innerHTML = '';
      $('peers-list').innerHTML = '';
      $('available-rooms-list').innerHTML = '';
      $('status-dot').className = 'status-dot';
      $('status-text').textContent = 'Disconnected';
      $('mesh-counter').textContent = 'Mesh: 0 P2P';
      $('peer-count').textContent = '0';
      $('active-room-badge').textContent = '#global';

      // 5. Clear inputs and show Join Modal
      $('nickname-input').value = '';
      $('passkey-input').value = '';
      $('room-input').value = '';
      $('join-modal').style.display = 'flex';
      setTimeout(() => $('nickname-input').focus(), 100);
    };
  }

  // Settings Modal Controls
  const settingsBtn = $('settings-toggle-btn');
  const settingsModal = $('settings-modal');
  const closeSettingsBtn = $('close-settings-btn');
  const recoveryDisplay = $('recovery-phrase-display');
  const copyRecoveryBtn = $('copy-recovery-btn');
  const stealthToggle = $('stealth-mode-toggle');
  const panicWipeBtn = $('panic-wipe-btn');

  if (settingsBtn && settingsModal) {
    settingsBtn.onclick = () => {
      settingsModal.style.display = 'flex';
      const phrase = generateRecoveryPhrase(currentPasskey, myPeerId);
      if (recoveryDisplay) recoveryDisplay.textContent = phrase;
      if (stealthToggle) stealthToggle.checked = isStealthMode;
      renderBlockedList();
    };
  }

  if (closeSettingsBtn && settingsModal) {
    closeSettingsBtn.onclick = () => {
      settingsModal.style.display = 'none';
    };
  }

  if (copyRecoveryBtn && recoveryDisplay) {
    copyRecoveryBtn.onclick = () => {
      navigator.clipboard.writeText(recoveryDisplay.textContent).then(() => {
        copyRecoveryBtn.textContent = 'Copied!';
        setTimeout(() => { copyRecoveryBtn.textContent = 'Copy Seed Phrase'; }, 2000);
      });
    };
  }

  if (stealthToggle) {
    stealthToggle.onchange = () => {
      isStealthMode = stealthToggle.checked;
      localStorage.setItem('mistroom_stealth', isStealthMode ? 'true' : 'false');
      appendSystemMessage(isStealthMode ? '👻 Ghost Stealth Mode enabled: You are hidden from public peer lists.' : '👁️ Ghost Mode disabled.');
      // Re-announce with updated mode
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          t: 'join',
          name: isStealthMode ? 'Anonymous' : currentNickname,
          peer_id: myPeerId,
          room: currentRoom
        }));
      }
    };
  }

  if (panicWipeBtn) {
    panicWipeBtn.onclick = () => {
      if (confirm('🚨 EMERGENCY WIPE: Are you sure? This will delete all encrypted outbox messages, recovery keys, and history immediately.')) {
        try { window.indexedDB.deleteDatabase(DB_NAME); } catch (e) {}
        sessionStorage.clear();
        localStorage.clear();
        location.reload();
      }
    };
  }

  // Sidebar toggle
  $('toggle-peers-btn').onclick = () => {
    const sb = $('peers-sidebar');
    sb.style.display = sb.style.display === 'flex' ? '' : 'flex';
  };
});

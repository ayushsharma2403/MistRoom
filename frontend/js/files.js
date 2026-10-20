/**
 * P2P Encrypted File Sharing Engine (Chunking & Reassembly).
 */
import { state, $ } from './state.js';
import { encryptMessage, decryptMessage } from './crypto.js';
import { broadcastOverP2P, sendDeliveryAck } from './mesh.js';
import { appendMessageToUI, appendSystemMessage } from './ui.js';

// 9216 raw bytes produce exactly 12,288 bytes (12 KB) in standard base64 encoding
export const CHUNK_SIZE = 9216;

let lastRateLimitTime = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('mist_ws_error', e => {
    if (e.detail && e.detail.code === 'rate_limited') {
      lastRateLimitTime = Date.now();
    }
  });
}

async function sendChunkOverDataChannel(dc, packet) {
  const serialized = JSON.stringify(packet);
  if (dc.bufferedAmount > 65536) {
    await new Promise(resolve => {
      dc.bufferedAmountLowThreshold = 32768;
      const onLow = () => {
        dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', onLow);
    });
  }
  dc.send(serialized);
}

export async function dispatchFileChunkWithFlowControl(chunkPayload, targetPeerId) {
  let dc = null;
  if (targetPeerId) {
    const peer = state.meshPeers.get(targetPeerId);
    if (peer && peer.dc && peer.dc.readyState === 'open') {
      dc = peer.dc;
    }
  }

  if (dc) {
    // Data-channel send: wait on bufferedAmountLowThreshold, no fixed sleeps
    await sendChunkOverDataChannel(dc, chunkPayload);
    return true;
  }

  // Client relay send: at most 30 chunks/s (~34 ms between chunks), 12 KB base64 chunks;
  // on {"t":"error","code":"rate_limited"} wait 500 ms and resend that chunk (max 5 resends per chunk, then fail the transfer with a visible message).
  let resends = 0;
  while (resends <= 5) {
    if (Date.now() - lastRateLimitTime < 500) {
      await new Promise(r => setTimeout(r, 500));
    }
    const sendTime = Date.now();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ t: 'p2p_file', target: targetPeerId, data: chunkPayload }));
    }

    // Wait 34 ms to enforce at most 30 chunks/s
    await new Promise(r => setTimeout(r, 34));

    if (lastRateLimitTime > sendTime) {
      resends++;
      if (resends > 5) {
        throw new Error('File transfer failed: rate limited by server after 5 retry attempts.');
      }
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    return true;
  }
  throw new Error('File transfer failed: rate limited by server after 5 retry attempts.');
}

export function dispatchFilePacket(packet) {
  let sentViaP2P = false;
  if (packet.target_peer) {
    const peer = state.meshPeers.get(packet.target_peer);
    if (peer && peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(JSON.stringify(packet));
        sentViaP2P = true;
      } catch (e) {}
    }
  } else {
    // If we have open P2P peers, send only via P2P
    const count = broadcastOverP2P(packet);
    if (count > 0) {
      sentViaP2P = true;
    }
  }

  // Single path transmission: if sent over open DataChannel, do NOT send over WS relay
  if (!sentViaP2P && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ t: 'p2p_file', target: packet.target_peer, data: packet }));
  }
}

export function sanitizeFileName(name) {
  if (!name || typeof name !== 'string') return 'file.bin';
  // Strip path separators and control characters
  let clean = name.replace(/[\/\\:\*\?"<>\|\x00-\x1F\x7F]/g, '_');
  clean = clean.trim();
  if (!clean) clean = 'file.bin';
  if (clean.length > 100) {
    const extIdx = clean.lastIndexOf('.');
    if (extIdx > 0 && extIdx > clean.length - 15) {
      const ext = clean.slice(extIdx);
      clean = clean.slice(0, 100 - ext.length) + ext;
    } else {
      clean = clean.slice(0, 100);
    }
  }
  return clean;
}

export const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp'
]);

export function isSafePreviewMime(type) {
  return ALLOWED_IMAGE_MIMES.has((type || '').toLowerCase().trim());
}

export async function sendEncryptedFile(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    return alert('File size exceeds 25 MB limit for peer mesh.');
  }

  const safeName = sanitizeFileName(file.name);
  const fileId = 'f_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const targetPeerId = state.activeDirectPeer ? state.activeDirectPeer.peer_id : null;

  const progressBox = $('file-progress-container');
  const progressName = $('file-progress-name');
  const progressPct = $('file-progress-percent');
  const progressBar = $('file-progress-bar');
  if (progressBox) {
    progressBox.classList.add('is-shown');
    progressBox.classList.remove('is-hidden');
    progressName.textContent = `Encrypting & Sending: ${safeName}`;
    progressPct.textContent = '0%';
    progressBar.style.width = '0%';
  }

  // Encrypt file metadata inside v2 envelope
  const rawMeta = {
    name: safeName,
    size: file.size,
    type: file.type || 'application/octet-stream',
    totalChunks
  };
  const encMeta = await encryptMessage(JSON.stringify(rawMeta));

  const metaPayload = {
    t: 'file_meta',
    fileId,
    meta_env: encMeta, // Encrypted v2 envelope
    from: state.currentNickname,
    peer_id: state.myPeerId,
    target_peer: targetPeerId,
    room: state.currentRoom,
    ts: Date.now()
  };

  dispatchFilePacket(metaPayload);

  const buffer = await file.arrayBuffer();
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkSlice = buffer.slice(start, end);
    const b64Chunk = btoa(String.fromCharCode(...new Uint8Array(chunkSlice)));

    const encryptedChunk = await encryptMessage(b64Chunk);

    const chunkPayload = {
      t: 'file_chunk',
      fileId,
      index: i,
      totalChunks,
      envelope: encryptedChunk,
      target_peer: targetPeerId,
      room: state.currentRoom
    };

    try {
      await dispatchFileChunkWithFlowControl(chunkPayload, targetPeerId);
    } catch (err) {
      if (progressBox) {
        progressBox.classList.add('is-hidden');
        progressBox.classList.remove('is-shown');
      }
      appendSystemMessage(`❌ File transfer failed: ${err.message || 'Transfer rate limited.'}`);
      return;
    }

    const pct = Math.round(((i + 1) / totalChunks) * 100);
    if (progressPct && progressBar) {
      progressPct.textContent = `${pct}%`;
      progressBar.style.width = `${pct}%`;
    }
  }

  setTimeout(() => {
    if (progressBox) {
      progressBox.classList.add('is-hidden');
      progressBox.classList.remove('is-shown');
    }
  }, 1000);

  const blob = new Blob([buffer], { type: file.type });
  const objectUrl = URL.createObjectURL(blob);
  const localFileMsg = {
    id: fileId,
    from: state.currentNickname,
    peer_id: state.myPeerId,
    room: state.currentRoom,
    target_peer: targetPeerId,
    is_dm: !!targetPeerId,
    ts: Date.now(),
    file: {
      name: safeName,
      size: file.size,
      type: file.type,
      url: objectUrl
    },
    route: state.activeDirectPeer ? 'P2P Direct' : 'Mesh Broadcast'
  };

  state.messagesHistory.push(localFileMsg);
  appendMessageToUI(localFileMsg);
}

export async function handleIncomingFilePacket(packet) {
  if (packet.t === 'file_meta') {
    if (!packet.fileId || state.activeIncomingFiles.has(packet.fileId)) {
      // Ignore duplicate meta packet for the same fileId
      return;
    }

    // Decrypt metadata from v2 envelope
    let meta = null;
    if (packet.meta_env) {
      try {
        const decryptedJson = await decryptMessage(packet.meta_env);
        if (decryptedJson) {
          meta = JSON.parse(decryptedJson);
        }
      } catch (e) {
        console.debug('Failed to decrypt file metadata:', e);
      }
    } else if (packet.name && packet.totalChunks) {
      // Legacy fallback
      meta = {
        name: packet.name,
        size: packet.size,
        type: packet.type,
        totalChunks: packet.totalChunks
      };
    }

    if (!meta) {
      console.debug('Drop file packet with unreadable metadata');
      return;
    }

    const safeName = sanitizeFileName(meta.name);
    state.activeIncomingFiles.set(packet.fileId, {
      name: safeName,
      size: meta.size,
      type: meta.type,
      totalChunks: meta.totalChunks,
      receivedChunks: 0,
      chunks: new Array(meta.totalChunks),
      from: packet.from,
      peer_id: packet.peer_id,
      room: packet.room,
      target_peer: packet.target_peer,
      ts: packet.ts
    });
    appendSystemMessage(`📥 Receiving file "${safeName}" from ${packet.from}...`);
    return;
  }

  if (packet.t === 'file_chunk') {
    const entry = state.activeIncomingFiles.get(packet.fileId);
    if (!entry) return;

    if (!entry.chunks[packet.index]) {
      const envelope = packet.envelope;
      if (!envelope) return;

      const decryptedB64 = await decryptMessage(envelope);
      if (!decryptedB64) {
        console.debug('Failed to decrypt chunk index', packet.index);
        return;
      }

      const binaryString = atob(decryptedB64);
      const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
      entry.chunks[packet.index] = bytes.buffer;
      entry.receivedChunks++;

      if (entry.receivedChunks === entry.totalChunks) {
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

        state.activeIncomingFiles.delete(packet.fileId);
        state.messagesHistory.push(fileMsg);
        appendMessageToUI(fileMsg);
        appendSystemMessage(`✅ Successfully received file "${entry.name}".`);

        sendDeliveryAck(packet.fileId, entry.peer_id);
      }
    }
  }
}

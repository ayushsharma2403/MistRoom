/**
 * P2P Encrypted File Sharing Engine (Chunking & Reassembly).
 */
import { state, $ } from './state.js';
import { encryptMessage, decryptMessage } from './crypto.js';
import { broadcastOverP2P, sendDeliveryAck } from './mesh.js';
import { appendMessageToUI, appendSystemMessage } from './ui.js';

export const CHUNK_SIZE = 16384;

export function dispatchFilePacket(packet) {
  let count = 0;
  if (packet.target_peer) {
    const peer = state.meshPeers.get(packet.target_peer);
    if (peer && peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(JSON.stringify(packet));
        count = 1;
      } catch (e) {}
    }
  } else {
    count = broadcastOverP2P(packet);
  }

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ t: 'p2p_file', target: packet.target_peer, data: packet }));
  }
}

export async function sendEncryptedFile(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    return alert('File size exceeds 25 MB limit for peer mesh.');
  }

  const fileId = 'f_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const targetPeerId = state.activeDirectPeer ? state.activeDirectPeer.peer_id : null;

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

  const metaPayload = {
    t: 'file_meta',
    fileId,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    totalChunks,
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
      ciphertext: encryptedChunk.ciphertext,
      iv: encryptedChunk.iv,
      target_peer: targetPeerId,
      room: state.currentRoom
    };

    dispatchFilePacket(chunkPayload);

    const pct = Math.round(((i + 1) / totalChunks) * 100);
    if (progressPct && progressBar) {
      progressPct.textContent = `${pct}%`;
      progressBar.style.width = `${pct}%`;
    }

    if (i % 8 === 0) {
      await new Promise(r => setTimeout(r, 15));
    }
  }

  setTimeout(() => {
    if (progressBox) progressBox.style.display = 'none';
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
      name: file.name,
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
    state.activeIncomingFiles.set(packet.fileId, {
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
    const entry = state.activeIncomingFiles.get(packet.fileId);
    if (!entry) return;

    if (!entry.chunks[packet.index]) {
      const decryptedB64 = await decryptMessage(packet.ciphertext, packet.iv);
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
        appendSystemMessage(`✅ Successfully received and verified file "${entry.name}".`);

        sendDeliveryAck(packet.fileId, entry.peer_id);
      }
    }
  }
}

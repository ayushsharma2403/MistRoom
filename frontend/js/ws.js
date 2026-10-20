/**
 * WebSocket signaling and real-time mesh hub client.
 */
import { state, $ } from './state.js';
import {
  appendMessageToUI, updateMessageStatus, updateSOSBanner,
  renderPeers, renderAvailableRooms, updateBeaconBanner,
  renderBeaconListModal, renderNeedsBoard, renderMeshTopology
} from './ui.js';
import { handleIncomingFilePacket } from './files.js';
import { sendDeliveryAck, initWebRTCPeer } from './mesh.js';
import {
  handleIncomingCallInvite,
  startCallTimer, endCall
} from './calls.js';
import {
  decryptEnvelope, verifyMessageSignature, signChallengeNonce, signChallenge,
  bytesToBase64, deriveEncryptionKey, verifyGenericSig
} from './crypto.js';
import { createInbound } from './inbound.js';

const handleInboundMessage = createInbound({
  state,
  verifySignature: async (msg) => {
    if (msg.sig && msg.pk && msg.envelope) {
      return verifyMessageSignature(msg.envelope, msg.sig, msg.pk, msg.room, msg.id, msg.ts);
    }
    return true;
  },
  decryptEnvelope: async (msg) => {
    if (msg.envelope) {
      return decryptEnvelope(msg.envelope);
    }
    return null;
  },
  render: (msg) => {
    appendMessageToUI(msg);
    updateSOSBanner();
    if (msg.peer_id && msg.peer_id !== state.myPeerId) {
      sendDeliveryAck(msg.id, msg.peer_id);
    }
  },
  now: () => Date.now(),
});

export function connectWebSocket(onSwitchRoom) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${protocol}//${location.host}/ws`);

  state.ws.onopen = () => {
    $('status-dot').className = 'status-dot online';
    $('status-text').textContent = 'Authenticating...';
    // Server will immediately send challenge nonce upon connection.
  };

  state.ws.onclose = () => {
    $('status-dot').className = 'status-dot';
    $('status-text').textContent = 'Reconnecting...';
    setTimeout(() => connectWebSocket(onSwitchRoom), 3000);
  };

  state.ws.onmessage = async event => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.debug('Bad JSON frame from server dropped');
      return;
    }

    if (data.t === 'challenge') {
      if (!data.nonce || !state.identity) {
        console.debug('Missing challenge nonce or client identity');
        return;
      }
      const sigB64 = signChallenge(data.nonce);
      const pkB64 = bytesToBase64(state.identity.pubKey);
      state.ws.send(JSON.stringify({
        t: 'join',
        name: state.isStealthMode ? 'Ghost' : state.currentNickname,
        room: state.currentRoom,
        pk: pkB64,
        sig: sigB64,
        ghost: state.isStealthMode
      }));
      $('status-text').textContent = 'Online';

      // 5. Flush outbox after join handshake completes
      import('./outbox.js').then(o => o.flushOfflineOutbox());
      return;
    }

    if (data.t === 'history') {
      const incomingRoom = data.room || state.currentRoom;
      const isRoomSwitch = incomingRoom !== state.currentRoom;

      if (isRoomSwitch) {
        state.currentRoom = incomingRoom;
        $('active-room-badge').textContent = '#' + state.currentRoom;

        // Re-derive room key with new room salt
        if (state.currentPasskey) {
          state.cryptoKey = await deriveEncryptionKey(state.currentPasskey, state.currentRoom);
        }

        // Close and rebuild WebRTC peers for the new room
        for (const [, peer] of state.meshPeers) {
          try {
            if (peer.dc) peer.dc.close();
            if (peer.pc) peer.pc.close();
          } catch (e) {}
        }
        state.meshPeers.clear();
      }

      // Merge history by ID instead of wiping outbox / local system bubbles
      // Keep existing local notes, unsent/queued bubbles, or existing processed bubbles
      const existingIds = new Set(state.messagesHistory.map(m => m.id));
      const incomingHistory = data.history || [];

      for (const m of incomingHistory) {
        if (!m || !m.id) continue;
        if (existingIds.has(m.id)) {
          // Already have it in state
          continue;
        }

        let isVerified = false;
        if (m.sig && m.pk && m.envelope) {
          isVerified = verifyMessageSignature(m.envelope, m.sig, m.pk, m.room, m.id, m.ts);
        }

        if (m.envelope) {
          const decrypted = await decryptEnvelope(m.envelope);
          if (decrypted !== null) {
            m.text = decrypted;
          } else {
            m.text = null;
            m.unreadable = true;
          }
        }
        m.verified = isVerified;
        state.messagesHistory.push(m);
        appendMessageToUI(m, false);
      }

      // 6. Server restart: when the server comes back, clients re-join, re-derive nothing,
      // and the user sees "Server restarted: earlier history is gone, local messages kept".
      if (incomingHistory.length === 0 && state.messagesHistory.some(m => !m.is_system && m.status !== 'queued')) {
        import('./ui.js').then(u => u.appendSystemMessage('⚠️ Server restarted: earlier history is gone, local messages kept.'));
      }

      // Sort chronological
      state.messagesHistory.sort((a, b) => (a.ts || 0) - (b.ts || 0));

      $('messages-list').scrollTop = $('messages-list').scrollHeight;
      updateSOSBanner();
    }

    if (data.t === 'beacon') {
      if (!data.id || state.activeBeacons.has(data.id)) return;
      if (!data.pk || !data.sig) return;
      const lat_str = data.lat !== null && data.lat !== undefined ? String(data.lat) : '';
      const lon_str = data.lon !== null && data.lon !== undefined ? String(data.lon) : '';
      const payloadStr = `beacon|${data.id}|${data.cat}|${data.prio}|${data.short_text}|${lat_str}|${lon_str}|${data.ts}`;
      const isValid = verifyGenericSig(payloadStr, data.sig, data.pk);
      if (!isValid) return;

      state.activeBeacons.set(data.id, data);
      updateBeaconBanner();
      renderBeaconListModal();
    }

    if (data.t === 'need_resolved') {
      if (data.id) {
        state.openNeeds.delete(data.id);
        renderNeedsBoard();
      }
    }

    if (data.t === 'msg') {
      if (data.msg) {
        handleInboundMessage(data.msg, 'Relay');
      }
    }

    if (data.t === 'msg_ack') {
      updateMessageStatus(data.id, data.status || 'delivered', data.from_peer);
    }

    if (data.t === 'p2p_file' && data.data) {
      handleIncomingFilePacket(data.data);
    }

    if (data.t === 'people') {
      state.currentPeersList = data.people || [];
      renderPeers(state.currentPeersList);
      if (data.available_rooms) {
        state.allDiscoveredRooms = Array.from(new Set(['global', ...data.available_rooms]));
        renderAvailableRooms(state.allDiscoveredRooms, onSwitchRoom);
      }
      state.currentPeersList.forEach(p => {
        if (p.peer_id && p.peer_id !== state.myPeerId && !state.meshPeers.has(p.peer_id)) {
          const isInitiator = state.myPeerId < p.peer_id;
          initWebRTCPeer(p.peer_id, isInitiator);
        }
      });
      renderMeshTopology();
    }

    if (data.t === 'webrtc_offer') {
      const sender = data.sender;
      if (!state.meshPeers.has(sender)) initWebRTCPeer(sender, false);
      const peer = state.meshPeers.get(sender);
      if (peer && peer.pc) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.data));
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        state.ws.send(JSON.stringify({ t: 'webrtc_answer', target: sender, data: answer }));
      }
    }

    if (data.t === 'webrtc_answer') {
      const peer = state.meshPeers.get(data.sender);
      if (peer && peer.pc) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.data));
      }
    }

    if (data.t === 'webrtc_ice') {
      const peer = state.meshPeers.get(data.sender);
      if (peer && peer.pc && data.data) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(data.data));
        } catch (e) {}
      }
    }

    if (data.t === 'call_invite' && data.data) {
      if (data.sender && state.blockedPeerIds.has(data.sender)) return;
      handleIncomingCallInvite(data.sender, data.sender_name || 'Peer', data.data);
    }

    if (data.t === 'call_accept' && data.data) {
      if (state.activeCallPeerConnection) {
        await state.activeCallPeerConnection.setRemoteDescription(new RTCSessionDescription(data.data));
        // Flush any buffered ICE candidates for caller
        if (state.pendingCallIceCandidates && state.pendingCallIceCandidates.length > 0) {
          for (const cand of state.pendingCallIceCandidates) {
            try {
              await state.activeCallPeerConnection.addIceCandidate(new RTCIceCandidate(cand));
            } catch (e) {}
          }
          state.pendingCallIceCandidates = [];
        }
        $('call-status-label').textContent = 'Connected';
        startCallTimer();
      }
    }

    if (data.t === 'call_decline') {
      endCall(false);
    }

    if (data.t === 'call_hangup') {
      endCall(false);
    }

    if (data.t === 'call_ice' && data.data) {
      if (state.activeCallPeerConnection && state.activeCallPeerConnection.remoteDescription) {
        try {
          await state.activeCallPeerConnection.addIceCandidate(new RTCIceCandidate(data.data));
        } catch (e) {}
      } else {
        // Buffer ICE candidates that arrive before peer connection or remote description exists
        if (!state.pendingCallIceCandidates) state.pendingCallIceCandidates = [];
        state.pendingCallIceCandidates.push(data.data);
      }
    }
  };
}

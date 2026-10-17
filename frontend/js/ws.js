/**
 * WebSocket signaling and real-time mesh hub client.
 */
import { state, $ } from './state.js';
import { decryptMessage } from './crypto.js';
import {
  appendMessageToUI, updateMessageStatus, updateSOSBanner,
  renderPeers, renderAvailableRooms
} from './ui.js';
import { handleIncomingFilePacket } from './files.js';
import { sendDeliveryAck, initWebRTCPeer } from './mesh.js';
import {
  handleIncomingCallInvite, activeCallPeerConnection,
  startCallTimer, endCall
} from './calls.js';

import {
  decryptEnvelope, verifyMessageSignature, signChallengeNonce,
  bytesToBase64
} from './crypto.js';

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
      const sigB64 = signChallengeNonce(data.nonce, state.identity.privateKey);
      const pkB64 = bytesToBase64(state.identity.publicKey);
      state.ws.send(JSON.stringify({
        t: 'join',
        name: state.isStealthMode ? 'Anonymous' : state.currentNickname,
        room: state.currentRoom,
        pk: pkB64,
        sig: sigB64
      }));
      $('status-text').textContent = 'Online';
      return;
    }

    if (data.t === 'history') {
      state.messagesHistory.length = 0;
      $('messages-list').textContent = '';
      for (const m of data.history) {
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
      $('messages-list').scrollTop = $('messages-list').scrollHeight;
      updateSOSBanner();
    }

    if (data.t === 'msg') {
      if (data.msg.peer_id && state.blockedPeerIds.has(data.msg.peer_id)) return;
      if (state.messagesHistory.some(m => m.id === data.msg.id)) return;

      const isTargetedToMe = data.msg.target_peer === state.myPeerId;
      const isBroadcast = !data.msg.target_peer;

      if (data.msg.target_peer && !isTargetedToMe && data.msg.peer_id !== state.myPeerId) return;
      if (isBroadcast && data.msg.room && data.msg.room !== state.currentRoom && !data.msg.sos) return;

      // Verify signature if envelope exists
      let isVerified = false;
      if (data.msg.sig && data.msg.pk && data.msg.envelope) {
        isVerified = verifyMessageSignature(data.msg.envelope, data.msg.sig, data.msg.pk, data.msg.room, data.msg.id, data.msg.ts);
        if (!isVerified) {
          console.debug('Dropped message with invalid signature or mismatched peer_id');
          return;
        }
      }

      if (data.msg.envelope) {
        const decrypted = await decryptEnvelope(data.msg.envelope);
        if (decrypted !== null) {
          data.msg.text = decrypted;
        } else {
          data.msg.text = null;
          data.unreadable = true;
        }
      } else if (data.msg.ciphertext && data.msg.iv) {
        // Fallback for mock/legacy
        data.msg.text = null;
        data.unreadable = true;
      }

      data.msg.verified = isVerified;
      state.messagesHistory.push(data.msg);
      appendMessageToUI(data.msg);
      updateSOSBanner();

      if (data.msg.peer_id && data.msg.peer_id !== state.myPeerId) {
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
      if (state.activeCallPeerConnection) {
        try {
          await state.activeCallPeerConnection.addIceCandidate(new RTCIceCandidate(data.data));
        } catch (e) {}
      }
    }
  };
}

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

export function connectWebSocket(onSwitchRoom) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${protocol}//${location.host}/ws`);

  state.ws.onopen = () => {
    $('status-dot').className = 'status-dot online';
    $('status-text').textContent = 'Online';
    state.ws.send(JSON.stringify({
      t: 'join',
      name: state.currentNickname,
      peer_id: state.myPeerId,
      room: state.currentRoom
    }));
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
      return;
    }

    if (data.t === 'history') {
      state.messagesHistory.length = 0;
      $('messages-list').textContent = '';
      for (const m of data.history) {
        if (m.ciphertext && m.iv) {
          m.text = await decryptMessage(m.ciphertext, m.iv);
        }
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

      if (data.msg.ciphertext && data.msg.iv) {
        data.msg.text = await decryptMessage(data.msg.ciphertext, data.msg.iv);
      }
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

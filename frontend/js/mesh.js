/**
 * WebRTC P2P DataChannel Mesh Networking.
 */
import { state, $ } from './state.js';
import { decryptMessage } from './crypto.js';
import { flushOfflineOutbox } from './outbox.js';
import {
  updateMessageStatus, appendMessageToUI, updateSOSBanner
} from './ui.js';
import { handleIncomingFilePacket } from './files.js';

export const RTC_CONFIG = {
  iceServers: []
};

export function updateMeshBadge() {
  const activeCount = Array.from(state.meshPeers.values())
    .filter(p => p.dc && p.dc.readyState === 'open').length;
  $('mesh-counter').textContent = `⚡ Mesh: ${activeCount} P2P`;
}

export function broadcastOverP2P(msg) {
  let count = 0;
  const serialized = JSON.stringify(msg);
  for (const [, peer] of state.meshPeers) {
    if (peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(serialized);
        count++;
      } catch (e) {}
    }
  }
  return count;
}

export function relayMultiHop(packet, incomingPeerId) {
  const serialized = JSON.stringify(packet);
  for (const [pId, peer] of state.meshPeers) {
    if (pId !== incomingPeerId && peer.dc && peer.dc.readyState === 'open') {
      try {
        peer.dc.send(serialized);
      } catch (e) {}
    }
  }
}

export function sendDeliveryAck(msgId, senderPeerId) {
  if (!msgId || !senderPeerId || senderPeerId === state.myPeerId) return;
  const ack = {
    t: 'msg_ack',
    id: msgId,
    target_peer: senderPeerId,
    from_peer: state.myPeerId,
    status: 'delivered'
  };

  const peer = state.meshPeers.get(senderPeerId);
  if (peer && peer.dc && peer.dc.readyState === 'open') {
    try {
      peer.dc.send(JSON.stringify(ack));
      return;
    } catch (e) {}
  }

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(ack));
  }
}

export function attachDataChannelEvents(dc, targetPeerId) {
  dc.onopen = () => {
    updateMeshBadge();
    flushOfflineOutbox();
  };
  dc.onclose = () => {
    state.meshPeers.delete(targetPeerId);
    updateMeshBadge();
  };
  dc.onmessage = async event => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.t === 'msg_ack') {
        updateMessageStatus(msg.id, msg.status || 'delivered');
        return;
      }

      if (msg.t === 'file_meta' || msg.t === 'file_chunk') {
        handleIncomingFilePacket(msg);
        return;
      }

      if (msg.peer_id && state.blockedPeerIds.has(msg.peer_id)) {
        return;
      }

      if (!msg.id) return;
      if (state.messagesHistory.some(m => m.id === msg.id)) return;

      const isTargetedToMe = msg.target_peer === state.myPeerId;
      const isBroadcast = !msg.target_peer;

      if (!state.forwardedMessageIds.has(msg.id)) {
        state.forwardedMessageIds.add(msg.id);
        const ttl = typeof msg.ttl === 'number' ? msg.ttl : 3;
        if (ttl > 1) {
          const relayedPacket = {
            ...msg,
            ttl: ttl - 1,
            hops: (msg.hops || 0) + 1
          };
          relayMultiHop(relayedPacket, targetPeerId);
        }
      }

      if (msg.target_peer && !isTargetedToMe) return;
      if (isBroadcast && msg.room && msg.room !== state.currentRoom && !msg.sos) return;

      if (msg.ciphertext && msg.iv) {
        msg.text = await decryptMessage(msg.ciphertext, msg.iv);
      }

      msg.route = msg.hops > 0 ? `Mesh (${msg.hops + 1}-Hop)` : 'P2P Direct';
      state.messagesHistory.push(msg);
      appendMessageToUI(msg);
      updateSOSBanner();

      sendDeliveryAck(msg.id, msg.peer_id);
    } catch (err) {
      console.error('DataChannel message parse error:', err);
    }
  };
}

export function initWebRTCPeer(targetPeerId, isInitiator) {
  if (state.meshPeers.has(targetPeerId)) return;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.meshPeers.set(targetPeerId, { pc, dc: null });

  pc.onicecandidate = event => {
    if (event.candidate && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ t: 'webrtc_ice', target: targetPeerId, data: event.candidate }));
    }
  };

  if (isInitiator) {
    const dc = pc.createDataChannel('mistmesh');
    attachDataChannelEvents(dc, targetPeerId);
    state.meshPeers.get(targetPeerId).dc = dc;

    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ t: 'webrtc_offer', target: targetPeerId, data: pc.localDescription }));
        }
      })
      .catch(console.error);
  } else {
    pc.ondatachannel = event => {
      attachDataChannelEvents(event.channel, targetPeerId);
      state.meshPeers.get(targetPeerId).dc = event.channel;
    };
  }
}

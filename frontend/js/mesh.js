/**
 * WebRTC P2P DataChannel Mesh Networking.
 */
import { state, $ } from './state.js';
import { decryptEnvelope, verifyMessageSignature, signAck, bytesToBase64 } from './crypto.js';
import { flushOfflineOutbox } from './outbox.js';
import {
  updateMessageStatus, appendMessageToUI, updateSOSBanner
} from './ui.js';
import { handleIncomingFilePacket } from './files.js';
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
  },
  now: () => Date.now(),
});

export function getRtcConfig() {
  if (state.customIceServers) {
    const urls = state.customIceServers.split(',').map(s => s.trim()).filter(Boolean);
    if (urls.length > 0) {
      return { iceServers: [{ urls }] };
    }
  }
  return { iceServers: [] }; // Default: no external STUN (host-only / local LAN)
}

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
  const sigB64 = signAck(msgId, 'delivered');
  const pkB64 = state.identity ? bytesToBase64(state.identity.pubKey) : '';
  const ack = {
    t: 'msg_ack',
    id: msgId,
    target_peer: senderPeerId,
    from_peer: state.myPeerId,
    status: 'delivered',
    pk: pkB64,
    sig: sigB64
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
        updateMessageStatus(msg.id, msg.status || 'delivered', msg.from_peer);
        return;
      }

      if (msg.t === 'beacon' && msg.id) {
        if (!state.activeBeacons.has(msg.id)) {
          state.activeBeacons.set(msg.id, msg);
          import('./ui.js').then(u => {
            u.updateBeaconBanner();
            u.renderBeaconListModal();
          });
        }
        return;
      }

      if (msg.t === 'need_resolved' && msg.id) {
        state.openNeeds.delete(msg.id);
        import('./ui.js').then(u => u.renderNeedsBoard());
        return;
      }

      if (msg.t === 'file_meta' || msg.t === 'file_chunk') {
        handleIncomingFilePacket(msg);
        return;
      }

      const ok = await handleInboundMessage(msg, 'P2P Direct');
      if (ok) {
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
        if (msg.peer_id && msg.peer_id !== state.myPeerId) {
          sendDeliveryAck(msg.id, msg.peer_id);
        }
      }
    } catch (err) {
      console.error('DataChannel message parse error:', err);
    }
  };
}

export function initWebRTCPeer(targetPeerId, isInitiator) {
  if (state.meshPeers.has(targetPeerId)) return;
  const pc = new RTCPeerConnection(getRtcConfig());
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

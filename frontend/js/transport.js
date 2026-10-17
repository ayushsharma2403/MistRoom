/**
 * Transport interface and message Router for MistRoom.
 * Supports multiple underlying transports (WebSocket, WebRTC P2P mesh, BLE).
 */
import { state } from './state.js';

/**
 * Base Transport Interface
 */
export class Transport {
  constructor(id, capabilities = {}) {
    this.id = id;
    this.capabilities = capabilities; // e.g. { broadcast: true, direct: true, lan: true }
    this._onPeerCb = null;
    this._onMessageCb = null;
    this._onPeerGoneCb = null;
  }

  onPeer(cb) { this._onPeerCb = cb; }
  onMessage(cb) { this._onMessageCb = cb; }
  onPeerGone(cb) { this._onPeerGoneCb = cb; }

  async start() { throw new Error('start() not implemented'); }
  async stop() { throw new Error('stop() not implemented'); }
  async send(peerId, bytes) { throw new Error('send() not implemented'); }
  async broadcast(bytes) { throw new Error('broadcast() not implemented'); }
}

/**
 * WebSocket Transport Implementation
 */
export class WsTransport extends Transport {
  constructor() {
    super('ws', { broadcast: true, direct: true, serverRelay: true });
  }

  async start() {
    // Managed via ws.js
    return true;
  }

  async stop() {
    if (state.ws) {
      try { state.ws.close(); } catch (e) {}
    }
  }

  async send(peerId, bytes) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      const msg = typeof bytes === 'string' ? JSON.parse(bytes) : bytes;
      msg.target_peer = peerId;
      state.ws.send(typeof bytes === 'string' ? bytes : JSON.stringify(msg));
      return true;
    }
    return false;
  }

  async broadcast(bytes) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      const str = typeof bytes === 'string' ? bytes : JSON.stringify(bytes);
      state.ws.send(str);
      return true;
    }
    return false;
  }
}

/**
 * WebRTC Mesh Transport Implementation
 */
export class RtcTransport extends Transport {
  constructor() {
    super('webrtc', { broadcast: true, direct: true, serverless: true });
  }

  async start() {
    return true;
  }

  async stop() {
    for (const [, peer] of state.meshPeers) {
      try {
        if (peer.dc) peer.dc.close();
        if (peer.pc) peer.pc.close();
      } catch (e) {}
    }
    state.meshPeers.clear();
  }

  async send(peerId, bytes) {
    const peer = state.meshPeers.get(peerId);
    if (peer && peer.dc && peer.dc.readyState === 'open') {
      try {
        const str = typeof bytes === 'string' ? bytes : JSON.stringify(bytes);
        peer.dc.send(str);
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  async broadcast(bytes) {
    let sent = 0;
    const str = typeof bytes === 'string' ? bytes : JSON.stringify(bytes);
    for (const [, peer] of state.meshPeers) {
      if (peer.dc && peer.dc.readyState === 'open') {
        try {
          peer.dc.send(str);
          sent++;
        } catch (e) {}
      }
    }
    return sent > 0;
  }
}

/**
 * Unified Message Router
 * Dedupes by message id, decrements TTL, relays across available transports.
 */
export class Router {
  constructor() {
    this.transports = new Map();
    this.seenMessageIds = new Set();
    this.maxSeenCache = 1000;
    this.onIncomingMessage = null;
  }

  registerTransport(transport) {
    this.transports.set(transport.id, transport);
    transport.onMessage((packet, sourcePeerId, sourceTransportId) => {
      this.routeIncoming(packet, sourcePeerId, sourceTransportId);
    });
  }

  getTransport(id) {
    return this.transports.get(id);
  }

  hasSeen(id) {
    return this.seenMessageIds.has(id);
  }

  markSeen(id) {
    if (!id) return;
    this.seenMessageIds.add(id);
    if (this.seenMessageIds.size > this.maxSeenCache) {
      const first = this.seenMessageIds.values().next().value;
      this.seenMessageIds.delete(first);
    }
  }

  async send(peerId, packet) {
    this.markSeen(packet.id);
    // Prefer direct RTC data channel if open
    const rtc = this.transports.get('webrtc');
    if (rtc && await rtc.send(peerId, packet)) {
      return true;
    }
    // Fallback to WebSocket relay if connected
    const ws = this.transports.get('ws');
    if (ws && await ws.send(peerId, packet)) {
      return true;
    }
    // Fallback to BLE
    const ble = this.transports.get('ble');
    if (ble && ble.capabilities.available) {
      return await ble.send(peerId, packet);
    }
    return false;
  }

  async broadcast(packet) {
    this.markSeen(packet.id);
    let delivered = false;
    const isBeacon = packet.t === 'beacon' || packet.cat === 'women_safety' || packet.cat === 'sos';

    if (isBeacon) {
      // Rule 8: Send BEACONs on ALL transports simultaneously
      for (const [, transport] of this.transports) {
        try {
          if (transport.capabilities.available !== false) {
            const sent = await transport.broadcast(packet);
            if (sent) delivered = true;
          }
        } catch (e) {}
      }
      return delivered;
    }

    // DATA priority: RTC data channel > WebSocket > BLE
    const rtc = this.transports.get('webrtc');
    if (rtc && await rtc.broadcast(packet)) {
      return true;
    }

    const ws = this.transports.get('ws');
    if (ws && state.ws && state.ws.readyState === WebSocket.OPEN) {
      if (await ws.broadcast(packet)) return true;
    }

    const ble = this.transports.get('ble');
    if (ble && ble.capabilities.available) {
      return await ble.broadcast(packet);
    }

    return false;
  }

  async routeIncoming(packet, sourcePeerId, sourceTransportId) {
    if (!packet || typeof packet !== 'object') return;

    // Deduplicate by message ID
    if (packet.id) {
      if (this.hasSeen(packet.id)) return;
      this.markSeen(packet.id);
    }

    // Multi-hop relay with TTL decrement (default TTL 4)
    const isTargetedToMe = packet.target_peer === state.myPeerId;
    const isBroadcast = !packet.target_peer;

    const ttl = typeof packet.ttl === 'number' ? packet.ttl : 4;
    if (ttl > 1) {
      const relayedPacket = {
        ...packet,
        ttl: ttl - 1,
        hops: (packet.hops || 0) + 1
      };
      this.relayMultiHop(relayedPacket, sourcePeerId);
    }

    // Deliver to local app if addressed to me or broadcast
    if ((isTargetedToMe || isBroadcast) && this.onIncomingMessage) {
      this.onIncomingMessage(packet, sourcePeerId, sourceTransportId);
    }
  }

  relayMultiHop(packet, incomingPeerId) {
    const serialized = JSON.stringify(packet);
    for (const [pId, peer] of state.meshPeers) {
      if (pId !== incomingPeerId && peer.dc && peer.dc.readyState === 'open') {
        try {
          peer.dc.send(serialized);
        } catch (e) {}
      }
    }
  }
}

// Global router singleton
export const router = new Router();
router.registerTransport(new WsTransport());
router.registerTransport(new RtcTransport());


// TransportManager.ts
// Tiered transport orchestrator:
//   Tier 1: WebSocket relay (cloud, always attempted)
//   Tier 2: WebRTC (local LAN P2P, when available)
//   Tier 3: BLE (Capacitor, offline proximity)
//
// Sending tries each tier in order until one succeeds.
// Inbound packets from all tiers are merged into a single event stream.

import type { MeshPacket } from '../mesh/MeshPacket';
import { forward, isExpired } from '../mesh/MeshPacket';
import { DedupCache } from '../mesh/DedupCache';
import { WebSocketTransport } from './WebSocketTransport';

export type TransportTier = 'ws' | 'webrtc' | 'ble' | 'none';

export interface TransportStatus {
  ws: 'connected' | 'disconnected';
  webrtc: number;  // number of connected peers
  ble: number;     // number of visible BLE nodes
}

export type PacketHandler = (packet: MeshPacket, via: TransportTier) => void;

const WS_URL = import.meta.env.VITE_RELAY_WS_URL ?? 'ws://localhost:8000/ws/v1/relay';

export class TransportManager {
  readonly ws: WebSocketTransport;
  private readonly dedup = new DedupCache();
  private readonly handlers = new Set<PacketHandler>();
  private _status: TransportStatus = { ws: 'disconnected', webrtc: 0, ble: 0 };

  constructor() {
    this.ws = new WebSocketTransport(WS_URL);

    this.ws.on((ev) => {
      if (ev.type === 'connected') {
        this._status = { ...this._status, ws: 'connected' };
        this.notifyStatus();
      } else if (ev.type === 'disconnected') {
        this._status = { ...this._status, ws: 'disconnected' };
        this.notifyStatus();
      } else if (ev.type === 'packet') {
        this.receive(ev.packet, 'ws');
      }
    });
  }

  private statusListeners = new Set<(s: TransportStatus) => void>();

  onStatusChange(cb: (s: TransportStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private notifyStatus(): void {
    this.statusListeners.forEach((cb) => cb(this._status));
  }

  get status(): TransportStatus {
    return { ...this._status };
  }

  /** Register a handler for inbound packets */
  onPacket(handler: PacketHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Process an inbound packet from any transport tier */
  receive(packet: MeshPacket, via: TransportTier): void {
    if (!this.dedup.tryAdd(packet.packetId)) return; // duplicate
    if (isExpired(packet)) return; // TTL exhausted
    this.handlers.forEach((h) => h(packet, via));

    // Forward to other tiers (mesh relay behaviour)
    const forwarded = forward(packet);
    if (!isExpired(forwarded)) {
      if (via !== 'ws') this.ws.send(forwarded);
      // WebRTC & BLE forwarding handled in their own transport modules
    }
  }

  /** Try to send a packet via the best available transport */
  send(packet: MeshPacket): TransportTier {
    if (this.ws.isConnected && this.ws.send(packet)) return 'ws';
    // WebRTC and BLE send attempts will be added as those transports are implemented
    return 'none';
  }

  start(): void {
    this.ws.connect();
  }

  stop(): void {
    this.ws.disconnect();
  }
}

// Singleton instance
export const transportManager = new TransportManager();

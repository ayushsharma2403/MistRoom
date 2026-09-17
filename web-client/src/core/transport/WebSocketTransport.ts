// WebSocketTransport.ts
// Tier 1: Connects to our Zero-Trust FastAPI relay via WebSockets.
// The server only ever receives encrypted binary packets — it cannot read content.

import type { MeshPacket } from '../mesh/MeshPacket';
import { serialize, deserialize } from '../mesh/MeshPacket';

export type WSEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; code: number }
  | { type: 'packet'; packet: MeshPacket }
  | { type: 'error'; error: Error };

export class WebSocketTransport {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(event: WSEvent) => void>();
  private reconnectDelay = 1000;

  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  on(listener: (event: WSEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: WSEvent): void {
    this.listeners.forEach((l) => l(event));
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.emit({ type: 'connected' });
    };

    this.ws.onmessage = (ev) => {
      try {
        const packet = deserialize(new Uint8Array(ev.data as ArrayBuffer));
        this.emit({ type: 'packet', packet });
      } catch (err) {
        this.emit({ type: 'error', error: err as Error });
      }
    };

    this.ws.onerror = () => {
      this.emit({ type: 'error', error: new Error('WebSocket error') });
    };

    this.ws.onclose = (ev) => {
      this.emit({ type: 'disconnected', code: ev.code });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
  }

  send(packet: MeshPacket): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(serialize(packet) as unknown as BufferSource);
    return true;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, 'Normal closure');
    this.ws = null;
  }
}

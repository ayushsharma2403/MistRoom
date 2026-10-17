/**
 * MistRoom BLE Mesh Protocol
 * Packet framing, fragmentation, reassembly, managed flooding, and priority queues.
 * Pure JS, zero external dependencies, 100% testable in Node or browser.
 */

export const BLE_PACKET_TYPES = {
  DATA: 0x01,
  BEACON: 0x02,
  ACK: 0x03,
  HELLO: 0x04,
  BADGE_REQ: 0x05,
  INV: 0x06,
  REQ_DATA: 0x07
};

export const BLE_HEADER_SIZE = 24; // 1(ver) + 1(type) + 1(ttl) + 1(flags) + 8(msgId) + 8(srcShort) + 2(seq) + 1(fragIdx) + 1(fragCount)
export const DEFAULT_PAYLOAD_MTU = 185;
export const MAX_REASSEMBLY_MSGS = 64;
export const REASSEMBLY_TIMEOUT_MS = 30000;

/**
 * Random 8-byte hex string
 */
export function generateMsgId() {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 8; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Encode HELLO payload { peerShort, ver, batteryBucket, pluggedIn }
 * 8 bytes peerShort (hex) + 1 byte ver + 1 byte (batteryBucket: 2 bits, pluggedIn: 1 bit)
 */
export function encodeHelloPayload({ peerShort = '', ver = 1, batteryBucket = 3, pluggedIn = false } = {}) {
  const bytes = new Uint8Array(10);
  const cleanSrc = (peerShort || '').padEnd(16, '0').slice(0, 16);
  for (let i = 0; i < 8; i++) {
    bytes[i] = parseInt(cleanSrc.substr(i * 2, 2), 16) || 0;
  }
  bytes[8] = ver & 0xFF;
  const flags = ((batteryBucket & 0x03) << 1) | (pluggedIn ? 1 : 0);
  bytes[9] = flags;
  return bytes;
}

/**
 * Decode HELLO payload into { peerShort, ver, batteryBucket, pluggedIn }
 */
export function decodeHelloPayload(bytes) {
  if (!bytes || bytes.length < 10) return null;
  let peerShort = '';
  for (let i = 0; i < 8; i++) {
    peerShort += bytes[i].toString(16).padStart(2, '0');
  }
  const ver = bytes[8];
  const flags = bytes[9];
  const batteryBucket = (flags >> 1) & 0x03;
  const pluggedIn = (flags & 0x01) === 1;
  return { peerShort, ver, batteryBucket, pluggedIn };
}

/**
 * Per-neighbor sliding window rate limiter (max 30 packets/sec)
 */
export class BleRateLimiter {
  constructor(maxPerSecond = 30) {
    this.maxPerSecond = maxPerSecond;
    this.deviceWindows = new Map(); // deviceId -> [timestamp, ...]
  }

  check(deviceId) {
    const now = Date.now();
    let timestamps = this.deviceWindows.get(deviceId);
    if (!timestamps) {
      timestamps = [];
      this.deviceWindows.set(deviceId, timestamps);
    }
    const cutoff = now - 1000;
    while (timestamps.length && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= this.maxPerSecond) {
      return false; // Rate exceeded
    }
    timestamps.push(now);
    return true;
  }

  cleanup() {
    const cutoff = Date.now() - 5000;
    for (const [id, list] of this.deviceWindows.entries()) {
      if (!list.length || list[list.length - 1] < cutoff) {
        this.deviceWindows.delete(id);
      }
    }
  }
}

/**
 * Encode a BLE packet header and payload into Uint8Array
 */
export function encodeBlePacket({
  ver = 1,
  type = BLE_PACKET_TYPES.DATA,
  ttl = 4,
  flags = 0,
  msgId = '', // 16 hex chars (8 bytes)
  srcShort = '', // 16 hex chars (8 bytes)
  seq = 0,
  fragIdx = 0,
  fragCount = 1,
  payload = new Uint8Array(0)
}) {
  const packet = new Uint8Array(BLE_HEADER_SIZE + payload.length);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  view.setUint8(0, ver);
  view.setUint8(1, type);
  view.setUint8(2, Math.min(ttl, 7)); // max 7
  view.setUint8(3, flags);

  // msgId (8 bytes)
  const cleanMsgId = (msgId || '').padEnd(16, '0').slice(0, 16);
  for (let i = 0; i < 8; i++) {
    view.setUint8(4 + i, parseInt(cleanMsgId.substr(i * 2, 2), 16) || 0);
  }

  // srcShort (8 bytes)
  const cleanSrc = (srcShort || '').padEnd(16, '0').slice(0, 16);
  for (let i = 0; i < 8; i++) {
    view.setUint8(12 + i, parseInt(cleanSrc.substr(i * 2, 2), 16) || 0);
  }

  view.setUint16(20, seq, false);
  view.setUint8(22, fragIdx);
  view.setUint8(23, fragCount);

  packet.set(payload, BLE_HEADER_SIZE);
  return packet;
}

/**
 * Decode Uint8Array into a BLE packet object
 */
export function decodeBlePacket(bytes) {
  if (bytes.length < BLE_HEADER_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const ver = view.getUint8(0);
  const type = view.getUint8(1);
  const ttl = view.getUint8(2) & 0x07;
  const flags = view.getUint8(3);

  let msgId = '';
  for (let i = 0; i < 8; i++) {
    msgId += view.getUint8(4 + i).toString(16).padStart(2, '0');
  }

  let srcShort = '';
  for (let i = 0; i < 8; i++) {
    srcShort += view.getUint8(12 + i).toString(16).padStart(2, '0');
  }

  const seq = view.getUint16(20, false);
  const fragIdx = view.getUint8(22);
  const fragCount = view.getUint8(23);
  const payload = bytes.slice(BLE_HEADER_SIZE);

  return { ver, type, ttl, flags, msgId, srcShort, seq, fragIdx, fragCount, payload };
}

/**
 * Fragment a payload into BLE packets fitting the MTU
 */
export function fragmentPayload(payloadBytes, headerInfo, mtu = 128) {
  const effectivePayloadChunk = Math.max(20, mtu - 3 - BLE_HEADER_SIZE);
  const totalLength = payloadBytes.length;
  const fragCount = Math.ceil(totalLength / effectivePayloadChunk) || 1;
  const fragments = [];

  for (let i = 0; i < fragCount; i++) {
    const start = i * effectivePayloadChunk;
    const end = Math.min(start + effectivePayloadChunk, totalLength);
    const chunk = payloadBytes.slice(start, end);

    const packet = encodeBlePacket({
      ...headerInfo,
      fragIdx: i,
      fragCount,
      payload: chunk
    });
    fragments.push(packet);
  }
  return fragments;
}

/**
 * Reassembly Buffer with timeout and LRU memory cap
 */
export class BleReassembler {
  constructor(timeoutMs = REASSEMBLY_TIMEOUT_MS, maxMsgs = MAX_REASSEMBLY_MSGS) {
    this.timeoutMs = timeoutMs;
    this.maxMsgs = maxMsgs;
    this.buffers = new Map(); // msgId -> { total, received, fragments: [], lastUpdated }
  }

  addFragment(decodedPacket) {
    const { msgId, fragIdx, fragCount, payload } = decodedPacket;
    const now = Date.now();
    this.evictExpired(now);

    if (fragCount === 1 && fragIdx === 0) {
      return payload; // single fragment complete
    }

    let buf = this.buffers.get(msgId);
    if (!buf) {
      if (this.buffers.size >= this.maxMsgs) {
        const oldestKey = this.buffers.keys().next().value;
        this.buffers.delete(oldestKey);
      }
      buf = {
        total: fragCount,
        receivedCount: 0,
        fragments: new Array(fragCount),
        lastUpdated: now
      };
      this.buffers.set(msgId, buf);
    }

    buf.lastUpdated = now;
    if (!buf.fragments[fragIdx]) {
      buf.fragments[fragIdx] = payload;
      buf.receivedCount++;
    }

    if (buf.receivedCount === buf.total) {
      this.buffers.delete(msgId);
      let totalLen = 0;
      for (const f of buf.fragments) totalLen += f.length;
      const assembled = new Uint8Array(totalLen);
      let offset = 0;
      for (const f of buf.fragments) {
        assembled.set(f, offset);
        offset += f.length;
      }
      return assembled;
    }

    return null;
  }

  evictExpired(now) {
    for (const [k, v] of this.buffers.entries()) {
      if (now - v.lastUpdated > this.timeoutMs) {
        this.buffers.delete(k);
      }
    }
  }
}

/**
 * Managed Flooding Engine with Seen Cache and Gossip Suppression
 */
export class BleManagedFlooder {
  constructor({ maxSeen = 2000, seenTtlMs = 600000, rebroadcastCb, getBatteryStatus } = {}) {
    this.seenCache = new Map(); // msgId -> { count, timestamp }
    this.maxSeen = maxSeen;
    this.seenTtlMs = seenTtlMs;
    this.rebroadcastCb = rebroadcastCb;
    this.getBatteryStatus = getBatteryStatus || (() => ({ batteryBucket: 3, pluggedIn: false }));
    this.pendingJitterTimers = new Map(); // msgId -> timerId
  }

  hasSeen(msgId) {
    const entry = this.seenCache.get(msgId);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > this.seenTtlMs) {
      this.seenCache.delete(msgId);
      return false;
    }
    return true;
  }

  recordPacket(decodedPacket) {
    const now = Date.now();
    const { msgId, ttl, type } = decodedPacket;
    let entry = this.seenCache.get(msgId);

    if (entry) {
      entry.count++;
      // Gossip suppression: if heard from >= 2 neighbors during jitter window, cancel rebroadcast
      if (entry.count >= 2 && this.pendingJitterTimers.has(msgId)) {
        clearTimeout(this.pendingJitterTimers.get(msgId));
        this.pendingJitterTimers.delete(msgId);
      }
      return false; // already seen, do not schedule new rebroadcast
    }

    // New packet seen
    if (this.seenCache.size >= this.maxSeen) {
      const oldestKey = this.seenCache.keys().next().value;
      this.seenCache.delete(oldestKey);
    }
    this.seenCache.set(msgId, { count: 1, timestamp: now });

    // Schedule rebroadcast if TTL > 1
    if (ttl > 1 && this.rebroadcastCb) {
      const { batteryBucket, pluggedIn } = this.getBatteryStatus();
      
      // Nodes with bucket 0 do not relay DATA (only send own messages & beacons)
      if (batteryBucket === 0 && type === BLE_PACKET_TYPES.DATA) {
        return true;
      }

      // Shorter jitter for bucket 3 or plugged in to rebroadcast first
      let jitterMs;
      if (pluggedIn || batteryBucket === 3) {
        jitterMs = Math.floor(Math.random() * 40) + 10; // 10 - 50 ms
      } else {
        jitterMs = Math.floor(Math.random() * 80) + 60; // 60 - 140 ms
      }

      const timer = setTimeout(() => {
        this.pendingJitterTimers.delete(msgId);
        const decremented = { ...decodedPacket, ttl: ttl - 1 };
        this.rebroadcastCb(decremented);
      }, jitterMs);
      this.pendingJitterTimers.set(msgId, timer);
    }

    return true; // first time seen
  }
}

/**
 * Priority Queue (BEACON > ACK > DATA)
 * Max queue 200; drops lowest priority items when full
 */
export class BlePriorityQueue {
  constructor(maxSize = 200) {
    this.maxSize = maxSize;
    this.queue = [];
  }

  getPriority(type) {
    if (type === BLE_PACKET_TYPES.BEACON) return 3;
    if (type === BLE_PACKET_TYPES.ACK) return 2;
    return 1; // DATA / HELLO
  }

  enqueue(item) {
    const prio = this.getPriority(item.type);
    item._prio = prio;

    if (this.queue.length >= this.maxSize) {
      // Find lowest priority oldest element to drop
      let dropIdx = -1;
      let minPrio = 999;
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i]._prio < minPrio) {
          minPrio = this.queue[i]._prio;
          dropIdx = i;
          if (minPrio === 1) break;
        }
      }
      if (dropIdx !== -1 && minPrio <= prio) {
        this.queue.splice(dropIdx, 1);
      } else {
        return false; // queue full of higher priority
      }
    }

    // Insert sorted by priority descending
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i]._prio < prio) {
        this.queue.splice(i, 0, item);
        inserted = true;
        break;
      }
    }
    if (!inserted) this.queue.push(item);
    return true;
  }

  dequeue() {
    return this.queue.shift() || null;
  }

  get length() {
    return this.queue.length;
  }
}

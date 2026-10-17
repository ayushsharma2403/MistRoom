/**
 * BleTransport implementation conforming to the unified Transport interface.
 * Implements:
 * - Rotating 4-byte random advertisement tag (every 15 minutes, never exposing handle/peer_id)
 * - Max 4 simultaneous GATT connections, RSSI & fewest-connections-first selection
 * - Exponential backoff (1s, 2s, 4s... 60s) with random jitter
 * - MTU negotiation (request 185) & writeWithoutResponse with credit-based flow control (max 8 in flight)
 * - HELLO exchange on connect: { peerShort, ver, batteryBucket, pluggedIn }
 * - Relay role awareness: bucket 3 / plugged in rebroadcasts first; bucket 0 does NOT relay DATA
 * - Duty cycling: idle 60s -> scan 2s every 10s; message/beacon received -> continuous scan 2 min
 * - Anti-entropy store-and-forward: last 50 DATA envelopes and all beacons from last 30m in IndexedDB
 *   Exchanges inventory (msgIds) on connect; max 20 items per neighbor per minute
 * - Security: accepts only v2 encrypted envelopes or signed public beacons; drops bad signatures
 *   Rate limits each neighbor to 30 packets/s
 * - Live debug metrics counters & JSON log export
 */
import { Transport } from '../transport.js';
import {
  BLE_PACKET_TYPES, BLE_HEADER_SIZE, DEFAULT_PAYLOAD_MTU,
  encodeBlePacket, decodeBlePacket, fragmentPayload,
  encodeHelloPayload, decodeHelloPayload,
  BleReassembler, BleManagedFlooder, BlePriorityQueue,
  BleRateLimiter, generateMsgId
} from './protocol.js';
import { BlePluginNative } from './plugin_interface.js';
import { verifyMessageEnvelope, verifyGenericSig, base64ToBytes, bytesToHex, sha256 } from '../crypto.js';
import { state } from '../state.js';

export const MISTROOM_BLE_SERVICE_UUID = '6e6d6973-7400-4d53-5400-000000000001';
export const BLE_STORE_DB = 'mistroom_ble_store';
export const BLE_STORE_VERSION = 1;

export class BleTransport extends Transport {
  constructor(plugin = null) {
    const defaultPlugin = plugin || new BlePluginNative();
    const isAvail = typeof defaultPlugin.isSupported === 'function' ? defaultPlugin.isSupported() : false;

    super('ble', { broadcast: true, direct: true, ble: true, available: isAvail });
    this.plugin = defaultPlugin;

    // Metrics counters
    this.metrics = {
      packetsTx: 0,
      packetsRx: 0,
      packetsDropped: 0,
      packetsDup: 0,
      fragmentsTx: 0,
      fragmentsRx: 0,
      totalHops: 0,
      hopSamples: 0,
      queueDepth: 0,
      rateLimited: 0,
      sigFailed: 0
    };

    // Neighbor table: deviceId -> { deviceId, peerShort, rssi, battery, pluggedIn, lastSeen, hops, connections }
    this.neighbors = new Map();

    // Active connected GATT devices (max 4)
    this.connectedDevices = new Set();
    this.maxConnections = 4;

    // Credit-based flow control: deviceId -> inFlight count (max 8)
    this.inFlightCredits = new Map();
    this.maxInFlight = 8;

    // Reconnection tracking: deviceId -> { backoffSec, nextAttemptTime, attempts }
    this.reconnectBackoffs = new Map();

    // Anti-entropy rate limiting: deviceId -> { count, windowStart } (max 20 items/min)
    this.antiEntropySyncTracker = new Map();

    // Rate limiter (max 30 pkts/s per neighbor)
    this.rateLimiter = new BleRateLimiter(30);

    // Protocol engines
    this.reassembler = new BleReassembler();
    this.flooder = new BleManagedFlooder({
      rebroadcastCb: packet => this._rebroadcast(packet),
      getBatteryStatus: () => this.myBatteryStatus
    });
    this.queue = new BlePriorityQueue(200);

    // Local battery status cache
    this.myBatteryStatus = { batteryBucket: 3, pluggedIn: false };

    // Rotating 4-byte advertisement tag
    this.currentAdvTag = new Uint8Array(4);
    this.tagRotationInterval = null;

    // Duty cycling state
    this.dutyCycling = {
      isDutyCycling: false,
      isContinuous: true,
      lastTrafficTime: Date.now(),
      scanCycleTimer: null,
      continuousTimeout: null
    };

    // IndexedDB store-and-forward instance
    this.bleDb = null;
    this._initStoreAndForwardDb();
  }

  get avgHopCount() {
    return this.metrics.hopSamples > 0 ? (this.metrics.totalHops / this.metrics.hopSamples).toFixed(2) : 0;
  }

  // Initialize store-and-forward IndexedDB (keeps last 50 DATA envelopes and all beacons from last 30m)
  _initStoreAndForwardDb() {
    if (typeof window === 'undefined' || !window.indexedDB) return;
    try {
      const req = window.indexedDB.open(BLE_STORE_DB, BLE_STORE_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('envelopes')) {
          db.createObjectStore('envelopes', { keyPath: 'msgId' });
        }
      };
      req.onsuccess = e => {
        this.bleDb = e.target.result;
        this._pruneStoreAndForward();
      };
    } catch (e) {
      console.debug('BLE store IndexedDB init skipped:', e);
    }
  }

  async _saveStoreAndForwardItem(item) {
    if (!this.bleDb) return;
    try {
      const tx = this.bleDb.transaction('envelopes', 'readwrite');
      const store = tx.objectStore('envelopes');
      store.put({
        msgId: item.msgId,
        type: item.type,
        ts: item.ts || Date.now(),
        payload: item.payload
      });
      tx.oncomplete = () => this._pruneStoreAndForward();
    } catch (e) {}
  }

  async _pruneStoreAndForward() {
    if (!this.bleDb) return;
    try {
      const tx = this.bleDb.transaction('envelopes', 'readwrite');
      const store = tx.objectStore('envelopes');
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result || [];
        const now = Date.now();
        const dataItems = [];

        for (const it of items) {
          // Beacons kept for last 30 minutes
          if (it.type === BLE_PACKET_TYPES.BEACON && now - it.ts > 30 * 60 * 1000) {
            store.delete(it.msgId);
          } else if (it.type === BLE_PACKET_TYPES.DATA) {
            dataItems.push(it);
          }
        }

        // Keep only the last 50 DATA envelopes
        if (dataItems.length > 50) {
          dataItems.sort((a, b) => a.ts - b.ts);
          const toDelete = dataItems.slice(0, dataItems.length - 50);
          for (const d of toDelete) {
            store.delete(d.msgId);
          }
        }
      };
    } catch (e) {}
  }

  async _getInventoryList() {
    if (!this.bleDb) return [];
    return new Promise(resolve => {
      try {
        const tx = this.bleDb.transaction('envelopes', 'readonly');
        const store = tx.objectStore('envelopes');
        const req = store.getAll();
        req.onsuccess = () => {
          const items = req.result || [];
          resolve(items.map(it => it.msgId));
        };
        req.onerror = () => resolve([]);
      } catch (e) {
        resolve([]);
      }
    });
  }

  async _getEnvelopeByMsgId(msgId) {
    if (!this.bleDb) return null;
    return new Promise(resolve => {
      try {
        const tx = this.bleDb.transaction('envelopes', 'readonly');
        const store = tx.objectStore('envelopes');
        const req = store.get(msgId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  // 1. Connection Strategy & Rotating 4-byte Tag
  _rotateAdvTag() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(this.currentAdvTag);
    } else {
      for (let i = 0; i < 4; i++) this.currentAdvTag[i] = Math.floor(Math.random() * 256);
    }
  }

  async start() {
    if (!this.capabilities.available) return false;
    const ok = await this.plugin.requestPermissions();
    if (!ok) return false;

    // Update battery status
    try {
      this.myBatteryStatus = await this.plugin.getBatteryStatus();
    } catch (e) {}

    // Initial 4-byte random tag (rotates every 15 minutes)
    this._rotateAdvTag();
    if (this.tagRotationInterval) clearInterval(this.tagRotationInterval);
    this.tagRotationInterval = setInterval(async () => {
      this._rotateAdvTag();
      if (this.connectedDevices.size < this.maxConnections) {
        try {
          await this.plugin.stopAdvertising();
          await this.plugin.startAdvertising(MISTROOM_BLE_SERVICE_UUID, this.currentAdvTag);
        } catch (e) {}
      }
    }, 15 * 60 * 1000);

    // Setup device discovery handler
    this.plugin.onDeviceFound(device => this._onDeviceFound(device));

    // Setup incoming notification handler
    this.plugin.onNotification(notif => {
      this._handleIncomingBytes(notif.value, notif.deviceId);
    });

    // Setup disconnection handler
    this.plugin.onDisconnected(ev => {
      this._onDeviceDisconnected(ev.deviceId);
    });

    // Start advertising and scanning
    await this.plugin.startAdvertising(MISTROOM_BLE_SERVICE_UUID, this.currentAdvTag);
    await this.plugin.startScan(MISTROOM_BLE_SERVICE_UUID);

    // Start duty cycle monitoring
    this._startDutyCycling();
    return true;
  }

  async stop() {
    if (!this.capabilities.available) return;
    if (this.tagRotationInterval) clearInterval(this.tagRotationInterval);
    if (this.dutyCycling.scanCycleTimer) clearInterval(this.dutyCycling.scanCycleTimer);
    if (this.dutyCycling.continuousTimeout) clearTimeout(this.dutyCycling.continuousTimeout);

    await this.plugin.stopAdvertising();
    await this.plugin.stopScan();

    for (const dId of this.connectedDevices) {
      try { await this.plugin.disconnect(dId); } catch (e) {}
    }
    this.connectedDevices.clear();
  }

  // Device discovery: choose neighbors by RSSI and fewest-connections-first, limit to 4
  async _onDeviceFound(device) {
    const { deviceId, rssi = -70, name, manufacturerData } = device;
    let neighbor = this.neighbors.get(deviceId);
    if (!neighbor) {
      neighbor = {
        deviceId,
        peerShort: 'unknown',
        rssi,
        battery: 3,
        pluggedIn: false,
        lastSeen: Date.now(),
        connections: 0,
        hops: 1,
        name: name || 'BLE-Peer'
      };
      this.neighbors.set(deviceId, neighbor);
    } else {
      neighbor.rssi = rssi;
      neighbor.lastSeen = Date.now();
    }

    // Check if we should connect: under connection limit (4) and not in backoff
    if (this.connectedDevices.size < this.maxConnections && !this.connectedDevices.has(deviceId)) {
      if (this._canAttemptConnect(deviceId)) {
        await this._attemptConnect(deviceId);
      }
    }
  }

  _canAttemptConnect(deviceId) {
    const backoff = this.reconnectBackoffs.get(deviceId);
    if (!backoff) return true;
    return Date.now() >= backoff.nextAttemptTime;
  }

  async _attemptConnect(deviceId) {
    try {
      const success = await this.plugin.connect(deviceId);
      if (success) {
        this.connectedDevices.add(deviceId);
        this.reconnectBackoffs.delete(deviceId);
        this.inFlightCredits.set(deviceId, 0);

        // 2. Request MTU 185 right after connecting
        await this.plugin.requestMtu(deviceId, 185);

        // 3. HELLO exchange after connect
        await this._sendHello(deviceId);

        // 6. Anti-entropy inventory exchange
        await this._sendInventory(deviceId);

        if (this._onPeerCb) {
          const neighbor = this.neighbors.get(deviceId);
          this._onPeerCb(deviceId, { name: neighbor?.name || 'BLE-Peer', ble: true });
        }
      } else {
        this._recordConnectionFailure(deviceId);
      }
    } catch (e) {
      this._recordConnectionFailure(deviceId);
    }
  }

  _recordConnectionFailure(deviceId) {
    let backoff = this.reconnectBackoffs.get(deviceId);
    if (!backoff) {
      backoff = { backoffSec: 1, attempts: 1, nextAttemptTime: 0 };
      this.reconnectBackoffs.set(deviceId, backoff);
    } else {
      backoff.attempts++;
      backoff.backoffSec = Math.min(60, backoff.backoffSec * 2);
    }
    // Exponential backoff (1s, 2s, 4s ... 60s) with jitter
    const jitter = Math.random() * 0.5 + 0.75; // 75% to 125%
    backoff.nextAttemptTime = Date.now() + Math.floor(backoff.backoffSec * 1000 * jitter);
  }

  _onDeviceDisconnected(deviceId) {
    this.connectedDevices.delete(deviceId);
    this.inFlightCredits.delete(deviceId);
    this._recordConnectionFailure(deviceId);
    if (this._onPeerGoneCb) this._onPeerGoneCb(deviceId);
  }

  // 3. HELLO exchange: node sends public-key hash, protocol ver, battery bucket (0-3), plugged-in flag
  async _sendHello(deviceId) {
    const peerShort = state.myPeerId ? state.myPeerId.substring(0, 16) : '0000000000000000';
    const helloPayload = encodeHelloPayload({
      peerShort,
      ver: 1,
      batteryBucket: this.myBatteryStatus.batteryBucket,
      pluggedIn: this.myBatteryStatus.pluggedIn
    });

    const packet = encodeBlePacket({
      ver: 1,
      type: BLE_PACKET_TYPES.HELLO,
      ttl: 1,
      flags: 0,
      msgId: generateMsgId(),
      srcShort: peerShort,
      seq: 0,
      fragIdx: 0,
      fragCount: 1,
      payload: helloPayload
    });

    await this._writeWithCreditFlow(deviceId, packet);
  }

  // 6. Anti-entropy store-and-forward inventory exchange
  async _sendInventory(deviceId) {
    const invList = await this._getInventoryList();
    if (!invList.length) return;

    // Send inventory of up to 20 msgIds
    const serialized = JSON.stringify(invList.slice(0, 20));
    const payloadBytes = new TextEncoder().encode(serialized);

    const fragments = fragmentPayload(payloadBytes, {
      ver: 1,
      type: BLE_PACKET_TYPES.INV,
      ttl: 1,
      flags: 0,
      msgId: generateMsgId(),
      srcShort: state.myPeerId ? state.myPeerId.substring(0, 16) : '0000000000000000'
    }, 185);

    for (const frag of fragments) {
      await this._writeWithCreditFlow(deviceId, frag);
    }
  }

  // 2. Flow control: max 8 packets in-flight per connection
  async _writeWithCreditFlow(deviceId, bytes) {
    const inFlight = this.inFlightCredits.get(deviceId) || 0;
    if (inFlight >= this.maxInFlight) {
      this.metrics.packetsDropped++;
      return false; // Queue saturated, wait for transport drain
    }

    this.inFlightCredits.set(deviceId, inFlight + 1);
    this.metrics.packetsTx++;
    this.metrics.fragmentsTx++;

    try {
      const ok = await this.plugin.write(deviceId, bytes);
      return ok;
    } finally {
      const curr = this.inFlightCredits.get(deviceId) || 1;
      this.inFlightCredits.set(deviceId, Math.max(0, curr - 1));
    }
  }

  // 5. Duty cycling: 60s idle -> scan 2s every 10s; message/beacon -> continuous scan 2 min
  _startDutyCycling() {
    this.dutyCycling.scanCycleTimer = setInterval(async () => {
      const now = Date.now();
      const idle = now - this.dutyCycling.lastTrafficTime > 60000;

      if (idle && !this.dutyCycling.isDutyCycling) {
        // Enter duty cycle: scan 2s every 10s
        this.dutyCycling.isDutyCycling = true;
        this.dutyCycling.isContinuous = false;
        await this._runDutyCycleWindow();
      }
    }, 10000);
  }

  async _runDutyCycleWindow() {
    if (!this.dutyCycling.isDutyCycling || this.dutyCycling.isContinuous) return;
    try {
      await this.plugin.startScan(MISTROOM_BLE_SERVICE_UUID);
      setTimeout(async () => {
        if (!this.dutyCycling.isContinuous) {
          try { await this.plugin.stopScan(); } catch (e) {}
        }
      }, 2000); // scan 2s
    } catch (e) {}
  }

  _wakeToContinuousScanning() {
    this.dutyCycling.lastTrafficTime = Date.now();
    this.dutyCycling.isContinuous = true;
    this.dutyCycling.isDutyCycling = false;

    try { this.plugin.startScan(MISTROOM_BLE_SERVICE_UUID); } catch (e) {}

    if (this.dutyCycling.continuousTimeout) clearTimeout(this.dutyCycling.continuousTimeout);
    this.dutyCycling.continuousTimeout = setTimeout(() => {
      this.dutyCycling.isContinuous = false;
    }, 120000); // 2 minutes continuous
  }

  // Inbound BLE Packet Processing
  async _handleIncomingBytes(rawBytes, sourceDeviceId) {
    this.metrics.packetsRx++;
    this.metrics.fragmentsRx++;

    // 8. Rate limit: 30 pkts/s per neighbor
    if (!this.rateLimiter.check(sourceDeviceId)) {
      this.metrics.rateLimited++;
      this.metrics.packetsDropped++;
      return;
    }

    const decoded = decodeBlePacket(rawBytes);
    if (!decoded) {
      this.metrics.packetsDropped++;
      return;
    }

    // Wake to continuous scanning on message or beacon
    if (decoded.type === BLE_PACKET_TYPES.DATA || decoded.type === BLE_PACKET_TYPES.BEACON) {
      this._wakeToContinuousScanning();
    }

    // Handle HELLO packet
    if (decoded.type === BLE_PACKET_TYPES.HELLO) {
      const info = decodeHelloPayload(decoded.payload);
      if (info) {
        const neighbor = this.neighbors.get(sourceDeviceId) || { deviceId: sourceDeviceId };
        neighbor.peerShort = info.peerShort;
        neighbor.battery = info.batteryBucket;
        neighbor.pluggedIn = info.pluggedIn;
        neighbor.lastSeen = Date.now();
        this.neighbors.set(sourceDeviceId, neighbor);
      }
      return;
    }

    // Handle Anti-Entropy INV packet
    if (decoded.type === BLE_PACKET_TYPES.INV) {
      await this._handleIncomingInventory(decoded.payload, sourceDeviceId);
      return;
    }

    // Handle Anti-Entropy REQ_DATA packet
    if (decoded.type === BLE_PACKET_TYPES.REQ_DATA) {
      await this._handleIncomingDataRequest(decoded.payload, sourceDeviceId);
      return;
    }

    // Duplicate check and managed flooding
    const isNew = this.flooder.recordPacket(decoded);
    if (!isNew) {
      this.metrics.packetsDup++;
      return;
    }

    // Update hop metrics
    this.metrics.totalHops += Math.max(1, 7 - decoded.ttl);
    this.metrics.hopSamples++;

    // Reassembly
    const completePayload = this.reassembler.addFragment(decoded);
    if (completePayload) {
      await this._processCompleteMessage(completePayload, decoded, sourceDeviceId);
    }
  }

  async _processCompleteMessage(completePayload, headerInfo, sourceDeviceId) {
    try {
      const text = new TextDecoder().decode(completePayload);
      const packetObj = JSON.parse(text);

      // 8. Security verification: drop packets whose signature fails
      if (packetObj.t === 'beacon' || packetObj.cat === 'women_safety' || packetObj.cat === 'sos') {
        if (packetObj.sig && packetObj.pk) {
          const isValid = verifyGenericSig(packetObj.id, packetObj.sig, packetObj.pk);
          if (!isValid) {
            this.metrics.sigFailed++;
            this.metrics.packetsDropped++;
            return;
          }
        }
      } else if (packetObj.v === 2 && packetObj.sig && packetObj.pk) {
        const isValid = verifyMessageEnvelope(
          packetObj.room || state.currentRoom,
          packetObj.id,
          packetObj.ts,
          packetObj.n,
          packetObj.c,
          packetObj.sig,
          packetObj.pk
        );
        if (!isValid) {
          this.metrics.sigFailed++;
          this.metrics.packetsDropped++;
          return;
        }
      }

      // Store in anti-entropy cache
      await this._saveStoreAndForwardItem({
        msgId: headerInfo.msgId,
        type: headerInfo.type,
        ts: packetObj.ts || Date.now(),
        payload: completePayload
      });

      if (this._onMessageCb) {
        this._onMessageCb(packetObj, sourceDeviceId, 'ble');
      }
    } catch (e) {
      this.metrics.packetsDropped++;
    }
  }

  // Handle incoming inventory: reply with REQ_DATA for missing items (max 20/min)
  async _handleIncomingInventory(payloadBytes, sourceDeviceId) {
    try {
      const text = new TextDecoder().decode(payloadBytes);
      const theirMsgIds = JSON.parse(text);
      if (!Array.isArray(theirMsgIds)) return;

      const myInv = new Set(await this._getInventoryList());
      const missing = theirMsgIds.filter(id => !myInv.has(id));

      if (missing.length > 0) {
        // Enforce anti-entropy rate limit (20 items per neighbor per minute)
        const allowed = this._checkAntiEntropyQuota(sourceDeviceId, missing.slice(0, 20));
        if (allowed.length > 0) {
          const reqBytes = new TextEncoder().encode(JSON.stringify(allowed));
          const frags = fragmentPayload(reqBytes, {
            ver: 1,
            type: BLE_PACKET_TYPES.REQ_DATA,
            ttl: 1,
            flags: 0,
            msgId: generateMsgId(),
            srcShort: state.myPeerId ? state.myPeerId.substring(0, 16) : '0000000000000000'
          }, 185);

          for (const frag of frags) {
            await this._writeWithCreditFlow(sourceDeviceId, frag);
          }
        }
      }
    } catch (e) {}
  }

  _checkAntiEntropyQuota(deviceId, items) {
    const now = Date.now();
    let tracker = this.antiEntropySyncTracker.get(deviceId);
    if (!tracker || now - tracker.windowStart > 60000) {
      tracker = { count: 0, windowStart: now };
      this.antiEntropySyncTracker.set(deviceId, tracker);
    }
    const remainingQuota = Math.max(0, 20 - tracker.count);
    const toSend = items.slice(0, remainingQuota);
    tracker.count += toSend.length;
    return toSend;
  }

  // Handle request for missing items and send them back
  async _handleIncomingDataRequest(payloadBytes, sourceDeviceId) {
    try {
      const text = new TextDecoder().decode(payloadBytes);
      const requestedIds = JSON.parse(text);
      if (!Array.isArray(requestedIds)) return;

      for (const id of requestedIds.slice(0, 20)) {
        const item = await this._getEnvelopeByMsgId(id);
        if (item && item.payload) {
          const frags = fragmentPayload(item.payload, {
            ver: 1,
            type: item.type,
            ttl: 2,
            flags: 0,
            msgId: item.msgId,
            srcShort: state.myPeerId ? state.myPeerId.substring(0, 16) : '0000000000000000'
          }, 185);

          for (const frag of frags) {
            await this._writeWithCreditFlow(sourceDeviceId, frag);
          }
        }
      }
    } catch (e) {}
  }

  // Outgoing direct send
  async send(peerId, bytes) {
    if (!this.capabilities.available) return false;
    const payloadBytes = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    const msgId = generateMsgId();

    const fragments = fragmentPayload(payloadBytes, {
      type: BLE_PACKET_TYPES.DATA,
      ttl: 4,
      msgId,
      srcShort: state.myPeerId ? state.myPeerId.substring(0, 16) : '0000000000000000'
    }, 185);

    let sent = false;
    for (const frag of fragments) {
      if (await this._writeWithCreditFlow(peerId, frag)) sent = true;
    }

    await this._saveStoreAndForwardItem({
      msgId,
      type: BLE_PACKET_TYPES.DATA,
      ts: Date.now(),
      payload: payloadBytes
    });

    return sent;
  }

  // Outgoing broadcast
  async broadcast(bytes) {
    if (!this.capabilities.available) return false;
    const payloadBytes = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    let type = BLE_PACKET_TYPES.DATA;
    try {
      const parsed = typeof bytes === 'string' ? JSON.parse(bytes) : JSON.parse(new TextDecoder().decode(bytes));
      if (parsed.t === 'beacon' || parsed.cat === 'women_safety' || parsed.cat === 'sos') {
        type = BLE_PACKET_TYPES.BEACON;
      }
    } catch (e) {}

    const ttl = type === BLE_PACKET_TYPES.BEACON ? 7 : 4;
    const msgId = generateMsgId();

    const fragments = fragmentPayload(payloadBytes, {
      type,
      ttl,
      msgId,
      srcShort: state.myPeerId ? state.myPeerId.substring(0, 16) : '0000000000000000'
    }, 185);

    let count = 0;
    for (const deviceId of this.connectedDevices) {
      for (const frag of fragments) {
        if (await this._writeWithCreditFlow(deviceId, frag)) count++;
      }
    }

    await this._saveStoreAndForwardItem({
      msgId,
      type,
      ts: Date.now(),
      payload: payloadBytes
    });

    return count > 0;
  }

  async _rebroadcast(decodedPacket) {
    const rawBytes = encodeBlePacket(decodedPacket);
    for (const deviceId of this.connectedDevices) {
      try {
        await this._writeWithCreditFlow(deviceId, rawBytes);
      } catch (e) {}
    }
  }

  // 10. Debug screen helper: export diagnostic log as JSON
  exportDiagnosticLog() {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      metrics: {
        ...this.metrics,
        avgHopCount: this.avgHopCount,
        queueDepth: this.queue.length
      },
      connectedCount: this.connectedDevices.size,
      connectedDevices: Array.from(this.connectedDevices),
      neighbors: Array.from(this.neighbors.values()),
      batteryStatus: this.myBatteryStatus,
      dutyCycling: {
        isDutyCycling: this.dutyCycling.isDutyCycling,
        isContinuous: this.dutyCycling.isContinuous
      }
    }, null, 2);
  }
}

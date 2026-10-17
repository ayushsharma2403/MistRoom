/**
 * BleTransport implementation conforming to the unified Transport interface.
 * Uses BlePlugin; in standard browsers capabilities.available is false.
 */
import { Transport } from '../transport.js';
import {
  BLE_PACKET_TYPES, fragmentPayload, decodeBlePacket,
  BleReassembler, BleManagedFlooder, BlePriorityQueue, generateMsgId
} from './protocol.js';
import { BlePluginNative } from './plugin_interface.js';

export const MISTROOM_BLE_SERVICE_UUID = '6e6d6973-7400-4d53-5400-000000000001';

export class BleTransport extends Transport {
  constructor(plugin = null) {
    const defaultPlugin = plugin || new BlePluginNative();
    const isAvail = typeof defaultPlugin.isSupported === 'function' ? defaultPlugin.isSupported() : false;

    super('ble', { broadcast: true, direct: true, ble: true, available: isAvail });
    this.plugin = defaultPlugin;
    this.reassembler = new BleReassembler();
    this.flooder = new BleManagedFlooder({
      rebroadcastCb: packet => this._rebroadcast(packet)
    });
    this.queue = new BlePriorityQueue(200);
    this.discoveredDevices = new Map(); // deviceId -> meta
  }

  async start() {
    if (!this.capabilities.available) return false;
    const ok = await this.plugin.requestPermissions();
    if (!ok) return false;

    this.plugin.onDeviceFound(device => {
      this.discoveredDevices.set(device.deviceId, device);
      if (this._onPeerCb) this._onPeerCb(device.deviceId, { name: device.name || 'BLE-Peer' });
    });

    this.plugin.onNotification(notif => {
      this._handleIncomingBytes(notif.value, notif.deviceId);
    });

    await this.plugin.startAdvertising(MISTROOM_BLE_SERVICE_UUID, new Uint8Array([0x01]));
    await this.plugin.startScan(MISTROOM_BLE_SERVICE_UUID);
    return true;
  }

  async stop() {
    if (!this.capabilities.available) return;
    await this.plugin.stopAdvertising();
    await this.plugin.stopScan();
  }

  async send(peerId, bytes) {
    if (!this.capabilities.available) return false;
    const payloadBytes = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    const msgId = generateMsgId();

    const fragments = fragmentPayload(payloadBytes, {
      type: BLE_PACKET_TYPES.DATA,
      ttl: 4,
      msgId,
      srcShort: '0000000000000000'
    }, 128);

    let sent = false;
    for (const frag of fragments) {
      if (await this.plugin.write(peerId, frag)) sent = true;
    }
    return sent;
  }

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
      srcShort: '0000000000000000'
    }, 128);

    let count = 0;
    for (const [deviceId] of this.discoveredDevices) {
      for (const frag of fragments) {
        if (await this.plugin.write(deviceId, frag)) count++;
      }
    }
    return count > 0;
  }

  _handleIncomingBytes(rawBytes, sourceDeviceId) {
    const decoded = decodeBlePacket(rawBytes);
    if (!decoded) return;

    // Managed flooding: seen check & jitter rebroadcast
    const isNew = this.flooder.recordPacket(decoded);
    if (!isNew) return;

    // Fragment reassembly
    const completePayload = this.reassembler.addFragment(decoded);
    if (completePayload && this._onMessageCb) {
      try {
        const text = new TextDecoder().decode(completePayload);
        const packetObj = JSON.parse(text);
        this._onMessageCb(packetObj, sourceDeviceId, 'ble');
      } catch (e) {
        console.debug('Failed to parse reassembled BLE JSON:', e);
      }
    }
  }

  async _rebroadcast(decodedPacket) {
    const rawBytes = encodeBlePacket(decodedPacket);
    for (const [deviceId] of this.discoveredDevices) {
      try { await this.plugin.write(deviceId, rawBytes); } catch (e) {}
    }
  }
}

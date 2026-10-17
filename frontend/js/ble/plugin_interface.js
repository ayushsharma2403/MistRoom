/**
 * BLE Plugin Interface & Mock Implementation
 * Bridges Capacitor BLE / custom peripheral plugins with the unified Transport layer.
 */

export class BlePlugin {
  async startAdvertising(serviceUuid, data) { throw new Error('Not implemented'); }
  async stopAdvertising() { throw new Error('Not implemented'); }
  async startScan(serviceUuid) { throw new Error('Not implemented'); }
  async stopScan() { throw new Error('Not implemented'); }
  async connect(deviceId) { throw new Error('Not implemented'); }
  async write(deviceId, bytes) { throw new Error('Not implemented'); }
  onNotification(cb) { this._onNotificationCb = cb; }
  onDeviceFound(cb) { this._onDeviceFoundCb = cb; }
  onDisconnected(cb) { this._onDisconnectedCb = cb; }
  async getMtu(deviceId) { return 128; }
  async requestPermissions() { return true; }
}

/**
 * In-memory Mock BLE Plugin for testing and simulation
 */
export class MockBlePlugin extends BlePlugin {
  constructor(nodeId = 'node_0') {
    super();
    this.nodeId = nodeId;
    this.isAdvertising = false;
    this.isScanning = false;
    this.neighbors = new Map(); // deviceId -> MockBlePlugin
    this.connected = new Set();
  }

  addNeighbor(peerPlugin) {
    this.neighbors.set(peerPlugin.nodeId, peerPlugin);
    peerPlugin.neighbors.set(this.nodeId, this);
    if (this._onDeviceFoundCb) {
      this._onDeviceFoundCb({ deviceId: peerPlugin.nodeId, name: peerPlugin.nodeId });
    }
  }

  async startAdvertising(serviceUuid, data) {
    this.isAdvertising = true;
    return true;
  }

  async stopAdvertising() {
    this.isAdvertising = false;
    return true;
  }

  async startScan(serviceUuid) {
    this.isScanning = true;
    for (const [id, peer] of this.neighbors) {
      if (peer.isAdvertising && this._onDeviceFoundCb) {
        this._onDeviceFoundCb({ deviceId: id, name: id });
      }
    }
    return true;
  }

  async stopScan() {
    this.isScanning = false;
    return true;
  }

  async connect(deviceId) {
    if (this.neighbors.has(deviceId)) {
      this.connected.add(deviceId);
      return true;
    }
    return false;
  }

  async write(deviceId, bytes) {
    const peer = this.neighbors.get(deviceId);
    if (peer && peer._onNotificationCb) {
      peer._onNotificationCb({ deviceId: this.nodeId, value: bytes });
      return true;
    }
    return false;
  }

  async getMtu(deviceId) {
    return 128;
  }

  async requestPermissions() {
    return true;
  }
}

/**
 * Native Capacitor BLE Plugin Adapter
 */
export class BlePluginNative extends BlePlugin {
  constructor() {
    super();
    this.bleCentral = window.Capacitor?.Plugins?.BleClient || null;
    this.blePeripheral = window.Capacitor?.Plugins?.MistBlePeripheral || null;
  }

  isSupported() {
    return !!(this.bleCentral && this.blePeripheral);
  }

  async startAdvertising(serviceUuid, data) {
    if (!this.blePeripheral) return false;
    return await this.blePeripheral.startAdvertising({ serviceUuid, data });
  }

  async stopAdvertising() {
    if (!this.blePeripheral) return false;
    return await this.blePeripheral.stopAdvertising();
  }

  async startScan(serviceUuid) {
    if (!this.bleCentral) return false;
    return await this.bleCentral.requestLEScan(
      { services: [serviceUuid] },
      res => {
        if (this._onDeviceFoundCb) {
          this._onDeviceFoundCb({ deviceId: res.device.deviceId, name: res.device.name });
        }
      }
    );
  }

  async stopScan() {
    if (!this.bleCentral) return false;
    return await this.bleCentral.stopLEScan();
  }

  async connect(deviceId) {
    if (!this.bleCentral) return false;
    await this.bleCentral.connect(deviceId);
    return true;
  }

  async write(deviceId, bytes) {
    if (!this.bleCentral) return false;
    // Characteristic 6e6d6973-7400-4d53-5400-000000000002
    return await this.bleCentral.writeWithoutResponse(
      deviceId,
      '6e6d6973-7400-4d53-5400-000000000001',
      '6e6d6973-7400-4d53-5400-000000000002',
      bytes
    );
  }

  async getMtu(deviceId) {
    if (!this.bleCentral) return 128;
    try {
      return await this.bleCentral.requestMtu(deviceId, 256);
    } catch (e) {
      return 128;
    }
  }

  async requestPermissions() {
    if (!this.bleCentral) return false;
    try {
      await this.bleCentral.initialize();
      return true;
    } catch (e) {
      return false;
    }
  }
}

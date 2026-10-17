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
  async disconnect(deviceId) { throw new Error('Not implemented'); }
  async write(deviceId, bytes) { throw new Error('Not implemented'); }
  async requestMtu(deviceId, mtu = 185) { return 185; }
  onNotification(cb) { this._onNotificationCb = cb; }
  onDeviceFound(cb) { this._onDeviceFoundCb = cb; }
  onDisconnected(cb) { this._onDisconnectedCb = cb; }
  async getMtu(deviceId) { return 185; }
  async requestPermissions() { return true; }
  async scheduleExactAlarm(delaySeconds, actionPayload) { return true; }
  async cancelExactAlarm() { return true; }
  async getBatteryStatus() { return { batteryBucket: 3, pluggedIn: false }; }
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
    this.advertisedData = null;
    this.mtuMap = new Map();
    this.battery = { batteryBucket: 3, pluggedIn: false };
    this.alarms = [];
  }

  addNeighbor(peerPlugin) {
    this.neighbors.set(peerPlugin.nodeId, peerPlugin);
    peerPlugin.neighbors.set(this.nodeId, this);
    if (this._onDeviceFoundCb) {
      this._onDeviceFoundCb({
        deviceId: peerPlugin.nodeId,
        name: peerPlugin.nodeId,
        rssi: -65,
        manufacturerData: peerPlugin.advertisedData
      });
    }
    if (peerPlugin._onDeviceFoundCb) {
      peerPlugin._onDeviceFoundCb({
        deviceId: this.nodeId,
        name: this.nodeId,
        rssi: -65,
        manufacturerData: this.advertisedData
      });
    }
  }

  async startAdvertising(serviceUuid, data) {
    this.isAdvertising = true;
    this.advertisedData = data;
    for (const [id, peer] of this.neighbors) {
      if (peer.isScanning && peer._onDeviceFoundCb) {
        peer._onDeviceFoundCb({
          deviceId: this.nodeId,
          name: this.nodeId,
          rssi: -65,
          manufacturerData: data
        });
      }
    }
    return true;
  }

  async stopAdvertising() {
    this.isAdvertising = false;
    this.advertisedData = null;
    return true;
  }

  async startScan(serviceUuid) {
    this.isScanning = true;
    for (const [id, peer] of this.neighbors) {
      if (peer.isAdvertising && this._onDeviceFoundCb) {
        this._onDeviceFoundCb({
          deviceId: id,
          name: id,
          rssi: -65,
          manufacturerData: peer.advertisedData
        });
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
      const peer = this.neighbors.get(deviceId);
      if (peer) peer.connected.add(this.nodeId);
      return true;
    }
    return false;
  }

  async disconnect(deviceId) {
    this.connected.delete(deviceId);
    if (this._onDisconnectedCb) this._onDisconnectedCb({ deviceId });
    return true;
  }

  async write(deviceId, bytes) {
    const peer = this.neighbors.get(deviceId);
    if (peer && peer._onNotificationCb) {
      peer._onNotificationCb({ deviceId: this.nodeId, value: bytes });
      return true;
    }
    return false;
  }

  async requestMtu(deviceId, mtu = 185) {
    this.mtuMap.set(deviceId, mtu);
    return mtu;
  }

  async getMtu(deviceId) {
    return this.mtuMap.get(deviceId) || 185;
  }

  async requestPermissions() {
    return true;
  }

  async scheduleExactAlarm(delaySeconds, actionPayload) {
    const alarmId = setTimeout(() => {
      if (typeof window !== 'undefined' && window.dispatchEvent) {
        window.dispatchEvent(new CustomEvent('mistroom:native_alarm', { detail: actionPayload }));
      }
    }, delaySeconds * 1000);
    this.alarms.push(alarmId);
    return true;
  }

  async cancelExactAlarm() {
    for (const id of this.alarms) clearTimeout(id);
    this.alarms = [];
    return true;
  }

  async getBatteryStatus() {
    return this.battery;
  }
}

/**
 * Native Capacitor BLE Plugin Adapter
 */
export class BlePluginNative extends BlePlugin {
  constructor() {
    super();
    const cap = typeof window !== 'undefined' ? window.Capacitor : null;
    this.bleCentral = cap?.Plugins?.BleClient || null;
    this.blePeripheral = cap?.Plugins?.MistBlePeripheral || null;
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

  async disconnect(deviceId) {
    if (!this.bleCentral) return false;
    try {
      await this.bleCentral.disconnect(deviceId);
      return true;
    } catch (e) {
      return false;
    }
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

  async requestMtu(deviceId, mtu = 185) {
    if (!this.bleCentral) return 185;
    try {
      return await this.bleCentral.requestMtu(deviceId, mtu);
    } catch (e) {
      return 185;
    }
  }

  async getMtu(deviceId) {
    return await this.requestMtu(deviceId, 185);
  }

  async scheduleExactAlarm(delaySeconds, actionPayload) {
    if (!this.blePeripheral?.scheduleExactAlarm) {
      return false;
    }
    return await this.blePeripheral.scheduleExactAlarm({ delaySeconds, actionPayload });
  }

  async cancelExactAlarm() {
    if (!this.blePeripheral?.cancelExactAlarm) return false;
    return await this.blePeripheral.cancelExactAlarm();
  }

  async getBatteryStatus() {
    if (typeof navigator !== 'undefined' && navigator.getBattery) {
      try {
        const batt = await navigator.getBattery();
        const level = batt.level; // 0.0 - 1.0
        let bucket = 0;
        if (level > 0.75) bucket = 3;
        else if (level > 0.40) bucket = 2;
        else if (level > 0.15) bucket = 1;
        return { batteryBucket: bucket, pluggedIn: !!batt.charging };
      } catch (e) {}
    }
    return { batteryBucket: 3, pluggedIn: false };
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


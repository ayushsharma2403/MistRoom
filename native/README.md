# MistRoom Native Wrapper (Capacitor + Custom BLE Mesh)

This directory contains the Capacitor native project scaffolding to wrap the pure web frontend into an Android (and iOS best-effort) application with Bluetooth Low Energy (BLE) peripheral advertising and foreground service capabilities.

The web build operates 100% independently without requiring Node.js at runtime.

---

## 1. Setup & Build Instructions

From your development workstation:

```bash
cd native
npm install
npx cap add android
npx cap sync
npx cap open android
```

In Android Studio, build the APK or run directly on your test device.

---

## 2. Android Permissions & Background Operation

The following permissions are required in `android/app/src/main/AndroidManifest.xml`:

```xml
<!-- BLE Permissions for Android 12+ (API level 31+) -->
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
    android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />

<!-- Legacy Location for BLE discovery on Android 6.0 - 11 -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"
    android:maxSdkVersion="30" />

<!-- Continuous Background Mesh Hopping -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

---

## 3. Testing Matrix: Simulation vs. Physical Hardware

| Capability | Tested in Node Simulator (`tests/ble_sim.js`) | Requires Physical Android/iOS Device |
| :--- | :---: | :---: |
| Packet framing & header serialization | ✅ Tested | - |
| Dynamic MTU fragmentation (128B, 256B, 512B) | ✅ Tested | - |
| Out-of-order & duplicate fragment reassembly | ✅ Tested | - |
| TTL decrement & loop expiry (max 7 hops) | ✅ Tested | - |
| Managed flooding & gossip cancellation | ✅ Tested (10 nodes) | - |
| Priority queue preemption (BEACON > ACK > DATA) | ✅ Tested | - |
| Radio frequency interference & physical distance | - | 📱 Requires Real Hardware |
| Real Bluetooth chip vendor quirks & MTU negotiation | - | 📱 Requires Real Hardware |
| Android OS aggressive battery background killers | - | 📱 Requires Real Hardware |
| iOS CoreBluetooth background advertising limits | - | 📱 Requires Real Hardware |

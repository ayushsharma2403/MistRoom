# BLE Mesh Manual Test Plan & Device Verification Matrix

This document defines the manual testing procedures for MistRoom Bluetooth Low Energy (BLE) Mesh between physical Android devices, as well as the verification results across unit, simulation, and hardware test matrices.

---

## 1. Test Topology: 3-4 Android Devices in a Line

```
[Phone A] <--- (BLE Link 1) ---> [Phone B] <--- (BLE Link 2) ---> [Phone C]
                                                                        ^
                                                                        | (BLE Link 3)
                                                                  [Phone D] (Late Joiner)
```

- **Phone A & Phone C:** Placed ~40 meters apart or behind concrete walls so direct BLE RF reception is impossible (-95 dBm / out of range).
- **Phone B:** Positioned in the middle within LOS range of both Phone A and Phone C.
- **Phone D:** Turned on 5 minutes after Phone A has broadcasted an emergency beacon, positioned within range of Phone C.

---

## 2. Test Cases & Execution Procedures

### Test 1: 2-Hop Message Delivery (A -> B -> C)
1. **Setup:** Open MistRoom on Phones A, B, and C. Verify in Settings that **Bluetooth Mesh Relay** is ON.
2. **Observe:** In the **Mesh** panel, verify:
   - Phone A shows 1 BLE link (`Phone B`).
   - Phone B shows 2 BLE links (`Phone A`, `Phone C`).
   - Phone C shows 1 BLE link (`Phone B`).
3. **Action:** Send a chat message `"Test multi-hop delivery from Phone A"` from Phone A.
4. **Verification:**
   - Message arrives on Phone C within < 500 ms.
   - Hop counter displays `2 hops`.
   - Inspection of packet header confirms `TTL` decremented from 4 to 2.

### Test 2: Emergency Beacon Multi-Hop Flooding
1. **Action:** Trigger the **SOS Emergency Beacon** on Phone A.
2. **Verification:**
   - Phone B's screen flashes red with the audible emergency chime.
   - Phone C immediately triggers the audible emergency alert (< 200 ms later).
   - Flooder seen-cache suppresses redundant rebroadcasts (Phone B does not echo back to A).

### Test 3: Anti-Entropy Store-and-Forward (Late Joiner D)
1. **Action:** While Phone D is offline/out-of-range, Phone A broadcasts a public Women's Safety Beacon.
2. **Action:** Turn on Phone D and bring it within range of Phone C.
3. **Verification:**
   - Phones C and D perform a HELLO exchange followed by an `INV` (inventory list).
   - Phone D detects missing beacon `msgId` and requests it via `REQ_DATA`.
   - Phone C sends the stored beacon envelope from its local IndexedDB store (< 20 items/min quota).
   - Phone D renders the active beacon banner with verified Ed25519 signature.

### Test 4: Duty Cycling (Battery Preservation)
1. **Action:** Leave all phones idle with no messages or beacons for 60 seconds.
2. **Verification:**
   - Radio drops to duty cycle mode: scanning 2 seconds every 10 seconds.
   - As soon as Phone A sends a ping, Phone B immediately awakens to continuous scanning for 2 minutes.

### Test 5: Safe-Walk Background Alarm
1. **Action:** Start a 5-minute Safe-Walk timer on Phone A. Minimize MistRoom and lock the screen.
2. **Verification:**
   - Android persistent foreground notification `"MistRoom mesh is running"` remains active.
   - At T=0, Android `AlarmManager` exact alarm triggers `MistAlarmReceiver` and broadcasts the emergency beacon even with web view throttled.

---

## 3. Test Verification Matrix: Simulation vs. Physical Hardware

> [!NOTE]
> Per requirement 10, tests executed in this development environment are run using the Node.js headless BLE simulation suite (`tests/ble_sim.js`). Results on real physical devices require manual execution following the steps above.

| Requirement ID | Behavior | Verified in Simulation (`tests/ble_sim.js`) | Verified on Physical Android Devices |
| :--- | :--- | :---: | :---: |
| **Req 1** | Rotating 4-byte random tag every 15 min (no handle/peer_id leaked) | ✅ Pass | 📱 Pending Hardware Run |
| **Req 1** | Max 4 simultaneous GATT connections, RSSI selection, exponential backoff + jitter | ✅ Pass | 📱 Pending Hardware Run |
| **Req 2** | MTU 185 negotiation & credit flow control (max 8 in-flight) | ✅ Pass | 📱 Pending Hardware Run |
| **Req 3** | HELLO exchange { peerShort, ver, batteryBucket, pluggedIn } | ✅ Pass (Test 6) | 📱 Pending Hardware Run |
| **Req 4** | Relay roles: Bucket 3/plugged in rebroadcasts first; Bucket 0 drops DATA relay | ✅ Pass (Test 8) | 📱 Pending Hardware Run |
| **Req 5** | Duty cycling: idle 60s -> 2s/10s; message/beacon -> 2m continuous | ✅ Pass | 📱 Pending Hardware Run |
| **Req 6** | Store-and-forward anti-entropy: 50 DATA + 30m beacons in IndexedDB; max 20/min sync | ✅ Pass (Test 10) | 📱 Pending Hardware Run |
| **Req 7** | Android Foreground Service + AlarmManager exact alarms for Safe-walk | ✅ Code Verified | 📱 Requires Android OS runtime |
| **Req 8** | Security: v2 encrypted or signed beacons; drop bad signatures; rate limit 30 pkts/s | ✅ Pass (Test 7) | 📱 Pending Hardware Run |
| **Req 9** | Mesh panel UI: count, RSSI indicator, hops, status chip, debug modal | ✅ Pass | 📱 Pending Hardware Run |
| **Req 10** | 3-Phone Line Topology A-B-C 2-hop delivery & late-joiner D | ✅ Pass (Tests 9 & 10) | 📱 Pending Hardware Run |
